/**
 * 审批流：学生发起、老师/团队管理员审批（任一通过即生效）。
 *
 * 两类申请：
 * - task_done：学生把任务标成完成（含待办直跳）时由 lib/task.ts 拦截转申请，
 *   任务保持未完成直至通过；同任务同时最多一条 pending（partial unique index 兜底）。
 * - resource_usage：学生登记资源占用转为申请，**通过时才建占用行**；老师/
 *   管理员登记沿用原直登路径，不经审批。
 *
 * 审批人口径：团队角色 admin 或 teacher（team_members.role 单值，学生角色的
 * 老师身份不越权审批；建团者恒为 admin）。通知走站内私信（dm），申请时提醒
 * 审批人、决定后回执申请人——消息页的未读/轮询基础设施自动生效。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import {
  approvalRequests,
  projects,
  resourceUsages,
  tasks,
  teamMembers,
  teams,
  users,
  type ApprovalStatus,
  type ApprovalType,
  type TeamRole,
} from "@/db/schema";
import { AppError, ForbiddenError, isUniqueViolation } from "./errors";
import { getTeamMembership } from "./team";
import { sendDm } from "./dm";
import { recordTaskActivity } from "./activity";
import { notifyTaskCompleted } from "./notify";

export type ApprovalDecision = "approved" | "rejected";

/** 可审批的团队角色：老师或管理员 */
const APPROVER_ROLES: TeamRole[] = ["admin", "teacher"];

export function isApproverRole(role: TeamRole): boolean {
  return APPROVER_ROLES.includes(role);
}

// 私信发送失败不阻断主流程（与 notify.ts 的 fire-and-forget 同口径）
async function notifyDmSafe(fromId: string, toId: string, content: string): Promise<void> {
  if (fromId === toId) return;
  try {
    await sendDm(fromId, toId, { content });
  } catch (e) {
    console.error("[approval] 审批私信发送失败", e);
  }
}

// —— 查询 ——

/** 我在任一团队是老师/管理员吗（工作台默认布局与资源表单文案据此分流） */
export async function isApproverAnywhere(actorId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, actorId), inArray(teamMembers.role, APPROVER_ROLES)))
    .limit(1);
  return row != null;
}

/** 团队里所有可审批人的 id（老师 + 管理员） */
async function listTeamApproverIds(teamId: string, exec: typeof db | DbTx = db) {
  return exec
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), inArray(teamMembers.role, APPROVER_ROLES)));
}

/**
 * 工作台「待办审批」卡片：我在哪些团队是老师/管理员，就列那些团队的 pending 申请。
 * 最先提交的最先处理（createdAt 升序），上限 20 条。
 */
export type PendingApprovalRow = {
  id: string;
  type: ApprovalType;
  teamId: string;
  teamName: string;
  requesterId: string;
  requesterName: string;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  resourceName: string | null;
  purpose: string | null;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date;
};

export async function listPendingApprovalsForApprover(
  actorId: string,
  limit = 20,
): Promise<PendingApprovalRow[]> {
  const myTeams = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, actorId), inArray(teamMembers.role, APPROVER_ROLES)));
  if (myTeams.length === 0) return [];

  return db
    .select({
      id: approvalRequests.id,
      type: approvalRequests.type,
      teamId: approvalRequests.teamId,
      teamName: teams.name,
      requesterId: approvalRequests.requesterId,
      requesterName: users.name,
      taskId: approvalRequests.taskId,
      taskTitle: tasks.title,
      projectId: tasks.projectId,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      startTime: approvalRequests.startTime,
      endTime: approvalRequests.endTime,
      createdAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .innerJoin(teams, eq(approvalRequests.teamId, teams.id))
    .innerJoin(users, eq(approvalRequests.requesterId, users.id))
    .leftJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .where(
      and(
        eq(approvalRequests.status, "pending"),
        inArray(
          approvalRequests.teamId,
          myTeams.map((t) => t.teamId),
        ),
      ),
    )
    .orderBy(asc(approvalRequests.createdAt))
    .limit(limit);
}

/** 给定任务里还有 pending 完成申请的那些 id（看板「待审批」角标用） */
export async function listPendingTaskDoneTaskIds(taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await db
    .select({ taskId: approvalRequests.taskId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, "pending"),
        eq(approvalRequests.type, "task_done"),
        inArray(approvalRequests.taskId, taskIds),
      ),
    );
  return new Set(rows.map((r) => r.taskId).filter((id): id is string => id != null));
}

// —— 申请 ——

/**
 * 学生把任务标成完成（无论当前是待办还是进行中）→ 转为完成审批申请。
 * 由 updateTask 在状态变更前调用：申请行与动态随调用方事务（或连接池）落库，
 * 私信提醒随后发出。调用方在**非事务路径**须以 ApprovalRequestedError 中断本次
 * 状态变更（看板据此回弹卡片并展示提示）；事务路径跳过 status 字段即可。
 */
export async function requestTaskCompletion(
  actorId: string,
  taskId: string,
  exec: typeof db | DbTx = db,
): Promise<void> {
  const [task] = await exec
    .select({
      title: tasks.title,
      status: tasks.status,
      projectName: projects.name,
      teamId: projects.teamId,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");

  // 申请行落库；同任务已有 pending 时 partial unique index 报错，转成可读文案
  try {
    await exec.insert(approvalRequests).values({
      teamId: task.teamId,
      requesterId: actorId,
      type: "task_done",
      taskId,
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("该任务已有待审批的完成申请");
    throw e;
  }

  const approverIds = (await listTeamApproverIds(task.teamId, exec)).map((r) => r.userId);
  for (const approverId of approverIds) {
    // 事务路径下私信在申请行提交前发出：站内消息纯 DB 写，最坏情况是外层事务
    // 回滚后审批人多收到一条无源头的提醒，可接受（与 fire-and-forget 通知同口径）
    void notifyDmSafe(
      actorId,
      approverId,
      `【完成审批】${task.projectName} 的任务「${task.title}」申请标记完成，请到工作台「待办审批」卡片处理。`,
    );
  }
}

/** 任务状态离开 doing（拖回待办、被直接完成）时撤掉未决的完成申请 */
export async function withdrawTaskApprovals(
  taskId: string,
  exec: typeof db | DbTx = db,
): Promise<void> {
  await exec
    .delete(approvalRequests)
    .where(
      and(
        eq(approvalRequests.taskId, taskId),
        eq(approvalRequests.status, "pending"),
        eq(approvalRequests.type, "task_done"),
      ),
    );
}

/**
 * 学生登记资源占用 → 转为审批申请（通过时才建占用行）。
 * 老师/管理员不走这里：resources 的 action 层按角色分流到 createResourceUsage 直登。
 */
export async function requestResourceUsage(
  actorId: string,
  teamId: string,
  input: { resourceName: string; purpose?: string | null; startTime: Date; endTime?: Date | null },
): Promise<void> {
  const name = input.resourceName.trim();
  if (!name) throw new AppError("资源名不能为空");
  if (input.endTime && input.endTime.getTime() <= input.startTime.getTime())
    throw new AppError("结束时间须晚于开始时间");

  await db.insert(approvalRequests).values({
    teamId,
    requesterId: actorId,
    type: "resource_usage",
    resourceName: name,
    purpose: input.purpose?.trim() || null,
    startTime: input.startTime,
    endTime: input.endTime ?? null,
  });

  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  const approverIds = (await listTeamApproverIds(teamId)).map((r) => r.userId);
  for (const approverId of approverIds) {
    void notifyDmSafe(
      actorId,
      approverId,
      `【资源审批】${team?.name ?? "团队"} 的资源「${name}」申请占用，请到工作台「待办审批」卡片处理。`,
    );
  }
}

// —— 决定 ——

/**
 * 审批决定：老师/管理员任一人对 pending 申请给出通过或拒绝。
 *
 * 决定与业务写入同事务；两个审批人并发点同一条时靠「带 pending 条件的 UPDATE」
 * 原子抢占，后到者收到「该审批已被处理」。私信回执在事务提交后发（失败不回滚决定）。
 *
 * 通过 task_done：任务补成 done（须仍是 doing，状态已漂移则报错）+ 动态 + 完成通知；
 * 通过 resource_usage：按快照建占用行（占用人 = 申请人）。
 */
export async function decideApproval(
  actorId: string,
  requestId: string,
  decision: ApprovalDecision,
): Promise<void> {
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  if (!request) throw new AppError("审批不存在");

  const membership = await getTeamMembership(actorId, request.teamId);
  if (!membership || !isApproverRole(membership.role)) throw new ForbiddenError();

  // 通过的任务行：审批事务内更新成功后补发既有完成通知
  type TaskDoneRow = {
    id: string;
    title: string;
    dueDate: string | null;
    assigneeId: string | null;
    projectId: string;
    priority: string;
    completionNote: string | null;
    createdById: string | null;
  };
  let taskRow: TaskDoneRow | null = null;
  let objectText = "";

  await db.transaction(async (tx) => {
    // 原子抢占 pending
    const [decided] = await tx
      .update(approvalRequests)
      .set({ status: decision, approverId: actorId, decidedAt: sql`now()` })
      .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.status, "pending")))
      .returning();
    if (!decided) throw new AppError("该审批已被处理");

    if (decided.type === "task_done") {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, decided.taskId!));
      if (!task) throw new AppError("任务已不存在");
      objectText = `完成的任务「${task.title}」`;
      if (decision === "approved") {
        // 申请未决期间任务可能被挪到待办/进行中，只要还没完成就可通过
        if (task.status === "done") throw new AppError("任务状态已变化，无法通过该审批");
        // 经 updateTask 落「已完成」：保留父任务完成级联、字段动态与统一写入口径。
        // approvedBy 豁免写角色检查（审批人可能是只读的 teacher，权限已由审批流验证）；
        // 动态 import 斩断 task.ts ↔ approval.ts 的静态循环（task 顶层引 approval 的申请/撤回）。
        const { updateTask } = await import("./task");
        taskRow = await updateTask(actorId, decided.taskId!, { status: "done" }, { tx, approvedBy: true });
      } else {
        await recordTaskActivity(tx, [{ taskId: task.id, actorId, type: "approval_rejected" }]);
      }
    } else {
      objectText = `占用的资源「${decided.resourceName ?? ""}」`;
      if (decision === "approved") {
        if (!decided.resourceName || !decided.startTime)
          throw new AppError("审批数据不完整，无法登记占用");
        if (decided.endTime && decided.endTime.getTime() <= decided.startTime.getTime())
          throw new AppError("结束时间须晚于开始时间，请让申请人重新提交");
        await tx.insert(resourceUsages).values({
          teamId: decided.teamId,
          userId: decided.requesterId,
          resourceName: decided.resourceName,
          purpose: decided.purpose,
          startTime: decided.startTime,
          endTime: decided.endTime,
        });
      }
    }
  });

  // 回执申请人（事务已提交）
  const [approver] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const approverName = approver?.name ?? "管理员";
  await notifyDmSafe(
    actorId,
    request.requesterId,
    decision === "approved"
      ? `【审批通过】你申请${objectText}已获通过（审批人：${approverName}）。`
      : `【审批被拒】你申请${objectText}未获通过（审批人：${approverName}），如有疑问请与其沟通。`,
  );

  // 通过的任务走既有完成通知口径（知会创建者/负责人）
  if (taskRow) void notifyTaskCompleted(taskRow, actorId);
}

/** 决定后的申请行状态（测试用） */

/** 决定后的申请行状态（测试用） */
export async function getApprovalStatus(requestId: string): Promise<ApprovalStatus | null> {
  const [row] = await db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  return row?.status ?? null;
}
