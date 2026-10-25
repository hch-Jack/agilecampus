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
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import {
  approvalRequests,
  projects,
  resourceUsages,
  systemMessages,
  taskAttachments,
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
import { recordTaskActivity } from "./activity";
import { notifyTaskCompleted } from "./notify";

export type ApprovalDecision = "approved" | "rejected";

/** 可审批的团队角色：老师或管理员 */
const APPROVER_ROLES: TeamRole[] = ["admin", "teacher"];

export function isApproverRole(role: TeamRole): boolean {
  return APPROVER_ROLES.includes(role);
}

// 系统消息写入失败不阻断主流程（与 notify.ts 的 fire-and-forget 同口径）
async function notifySystemSafe(
  userId: string,
  approvalId: string,
  content: string,
  exec: typeof db | DbTx = db,
): Promise<void> {
  try {
    await exec.insert(systemMessages).values({ userId, approvalId, content });
  } catch (e) {
    console.error("[approval] 系统消息写入失败", e);
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
  let requestId: string;
  try {
    const [row] = await exec
      .insert(approvalRequests)
      .values({ teamId: task.teamId, requesterId: actorId, type: "task_done", taskId })
      .returning({ id: approvalRequests.id });
    requestId = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("该任务已有待审批的完成申请");
    throw e;
  }

  const [requester] = await exec.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const content = `【完成审批】${requester?.name ?? "有成员"} 申请完成任务「${task.title}」（${task.projectName}）`;
  const approverIds = (await listTeamApproverIds(task.teamId, exec)).map((r) => r.userId);
  for (const approverId of approverIds) {
    if (approverId === actorId) continue;
    await notifySystemSafe(approverId, requestId!, content, exec);
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

  const [row] = await db
    .insert(approvalRequests)
    .values({
      teamId,
      requesterId: actorId,
      type: "resource_usage",
      resourceName: name,
      purpose: input.purpose?.trim() || null,
      startTime: input.startTime,
      endTime: input.endTime ?? null,
    })
    .returning({ id: approvalRequests.id });
  const requestId = row.id;

  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, teamId));
  const [requester] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const content = `【资源审批】${requester?.name ?? "有成员"} 申请占用「${name}」（${team?.name ?? "团队"}）`;
  const approverIds = (await listTeamApproverIds(teamId)).map((r) => r.userId);
  for (const approverId of approverIds) {
    if (approverId === actorId) continue;
    await notifySystemSafe(approverId, requestId, content);
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

  // 回执申请人（事务已提交）：结果也走系统消息，与申请提醒同栏
  const [approver] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const approverName = approver?.name ?? "管理员";
  await notifySystemSafe(
    request.requesterId,
    requestId,
    decision === "approved"
      ? `【审批通过】你申请${objectText}已获通过（审批人：${approverName}）。`
      : `【审批被拒】你申请${objectText}未获通过（审批人：${approverName}），如有疑问请与其沟通。`,
  );

  // 通过的任务走既有完成通知口径（知会创建者/负责人）
  if (taskRow) void notifyTaskCompleted(taskRow, actorId);
}

/** 决定后的申请行状态（测试用） */
export async function getApprovalStatus(requestId: string): Promise<ApprovalStatus | null> {
  const [row] = await db
    .select({ status: approvalRequests.status })
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  return row?.status ?? null;
}

// —— 系统消息 ——

/** 消息页「系统消息」一栏的一行。canDecide：这条申请正等着我批（老师/管理员视角） */
export type SystemMessageRow = {
  id: string;
  approvalId: string;
  content: string;
  readAt: Date | null;
  createdAt: Date;
  // 来自关联审批的上下文
  approvalType: ApprovalType;
  approvalStatus: ApprovalStatus;
  taskId: string | null;
  projectId: string | null;
  taskTitle: string | null;
  resourceName: string | null;
  purpose: string | null;
  startTime: Date | null;
  endTime: Date | null;
  requesterName: string;
  canDecide: boolean;
};

export async function listMySystemMessages(userId: string, limit = 30): Promise<SystemMessageRow[]> {
  const rows = await db
    .select({
      id: systemMessages.id,
      approvalId: systemMessages.approvalId,
      content: systemMessages.content,
      readAt: systemMessages.readAt,
      createdAt: systemMessages.createdAt,
      approvalType: approvalRequests.type,
      approvalStatus: approvalRequests.status,
      teamId: approvalRequests.teamId,
      taskId: approvalRequests.taskId,
      projectId: tasks.projectId,
      taskTitle: tasks.title,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      startTime: approvalRequests.startTime,
      endTime: approvalRequests.endTime,
      requesterName: users.name,
    })
    .from(systemMessages)
    .innerJoin(approvalRequests, eq(systemMessages.approvalId, approvalRequests.id))
    .innerJoin(users, eq(approvalRequests.requesterId, users.id))
    .leftJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .where(eq(systemMessages.userId, userId))
    .orderBy(desc(systemMessages.createdAt))
    .limit(limit);

  if (rows.length === 0) return [];

  // canDecide：批量取我在涉及团队里的角色（每个 teamId 只进一次集合再在内存判）
  const teamIds = [...new Set(rows.map((r) => r.teamId))];
  const myRoles = await db
    .select({ teamId: teamMembers.teamId, role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, teamIds)));
  const roleByTeam = new Map(myRoles.map((r) => [r.teamId, r.role]));

  return rows.map((r) => ({
    id: r.id,
    approvalId: r.approvalId,
    content: r.content,
    readAt: r.readAt,
    createdAt: r.createdAt,
    approvalType: r.approvalType,
    approvalStatus: r.approvalStatus,
    taskId: r.taskId,
    projectId: r.projectId,
    taskTitle: r.taskTitle,
    resourceName: r.resourceName,
    purpose: r.purpose,
    startTime: r.startTime,
    endTime: r.endTime,
    requesterName: r.requesterName,
    canDecide:
      r.approvalStatus === "pending" && isApproverRole(roleByTeam.get(r.teamId) ?? "student"),
  }));
}

export async function countUnreadSystemMessages(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(systemMessages)
    .where(and(eq(systemMessages.userId, userId), isNull(systemMessages.readAt)));
  return row?.count ?? 0;
}

/** 展开系统消息栏即全部置读（与 dm 打开会话即已读的口径一致） */
export async function markSystemMessagesRead(userId: string): Promise<void> {
  await db
    .update(systemMessages)
    .set({ readAt: sql`now()` })
    .where(and(eq(systemMessages.userId, userId), isNull(systemMessages.readAt)));
}

/**
 * 审批详情：审批人弹小窗查看申请内容（任务完成说明+附件 / 资源申请快照），
 * 学生本人也可回看结果。权限：该审批所在团队的老师/管理员，或申请人本人。
 */
export type ApprovalDetail = {
  approvalId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requesterName: string;
  taskId: string | null;
  projectId: string | null;
  taskTitle: string | null;
  resourceName: string | null;
  purpose: string | null;
  // 资源申请快照的起止时间（任务完成申请为 null）
  startTime: Date | null;
  endTime: Date | null;
  completionNote: string | null;
  decidedAt: Date | null;
  approverName: string | null;
  // 任务完成申请：任务页附件（学生作为「完成资料」上传的就在其中）
  attachments: { id: string; filename: string; mimeType: string | null; size: number }[];
};

export async function getApprovalDetail(
  actorId: string,
  approvalId: string,
): Promise<ApprovalDetail> {
  const [row] = await db
    .select({
      teamId: approvalRequests.teamId,
      requesterId: approvalRequests.requesterId,
      requesterName: users.name,
      type: approvalRequests.type,
      status: approvalRequests.status,
      taskId: approvalRequests.taskId,
      projectId: tasks.projectId,
      taskTitle: tasks.title,
      completionNote: tasks.completionNote,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      startTime: approvalRequests.startTime,
      endTime: approvalRequests.endTime,
      decidedAt: approvalRequests.decidedAt,
    })
    .from(approvalRequests)
    .innerJoin(users, eq(approvalRequests.requesterId, users.id))
    .leftJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .where(eq(approvalRequests.id, approvalId));
  if (!row) throw new AppError("审批不存在");

  if (row.requesterId !== actorId) {
    const membership = await getTeamMembership(actorId, row.teamId);
    if (!membership || !isApproverRole(membership.role)) throw new ForbiddenError();
  }

  let approverName: string | null = null;
  if (row.decidedAt) {
    const [decided] = await db
      .select({ approverId: approvalRequests.approverId })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, approvalId));
    if (decided?.approverId) {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, decided.approverId));
      approverName = u?.name ?? null;
    }
  }

  const attachments = row.taskId
    ? await db
        .select({
          id: taskAttachments.id,
          filename: taskAttachments.filename,
          mimeType: taskAttachments.mimeType,
          size: taskAttachments.size,
        })
        .from(taskAttachments)
        .where(eq(taskAttachments.taskId, row.taskId))
        .orderBy(desc(taskAttachments.createdAt))
    : [];

  return {
    approvalId,
    type: row.type,
    status: row.status,
    requesterName: row.requesterName,
    taskId: row.taskId,
    projectId: row.projectId,
    taskTitle: row.taskTitle,
    resourceName: row.resourceName,
    purpose: row.purpose,
    startTime: row.startTime,
    endTime: row.endTime,
    completionNote: row.completionNote,
    decidedAt: row.decidedAt,
    approverName,
    attachments,
  };
}

/**
 * 工作台看板徽章用：我在这些任务上**作为申请人**的最近一次审批状态。
 * 拒绝后重新申请会有多行，取最新一条即当前状态。
 */
export type TaskApprovalSummary = {
  taskId: string;
  status: ApprovalStatus;
  approverName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

export async function listMyTaskApprovalSummaries(
  userId: string,
  taskIds: string[],
): Promise<Map<string, TaskApprovalSummary>> {
  if (taskIds.length === 0) return new Map();
  const rows = await db
    .select({
      taskId: approvalRequests.taskId,
      status: approvalRequests.status,
      approverName: users.name,
      decidedAt: approvalRequests.decidedAt,
      createdAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .leftJoin(users, eq(approvalRequests.approverId, users.id))
    .where(
      and(
        eq(approvalRequests.requesterId, userId),
        eq(approvalRequests.type, "task_done"),
        inArray(approvalRequests.taskId, taskIds),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt));

  const map = new Map<string, TaskApprovalSummary>();
  for (const r of rows) {
    if (r.taskId && !map.has(r.taskId)) {
      map.set(r.taskId, {
        taskId: r.taskId,
        status: r.status,
        approverName: r.approverName,
        decidedAt: r.decidedAt,
        createdAt: r.createdAt,
      });
    }
  }
  return map;
}

/** 资源页「我的申请」：我的资源占用申请，倒序（与任务完成审批同款的状态可见性） */
export type MyResourceRequestRow = {
  id: string;
  resourceName: string | null;
  purpose: string | null;
  startTime: Date | null;
  endTime: Date | null;
  status: ApprovalStatus;
  approverName: string | null;
  decidedAt: Date | null;
  createdAt: Date;
};

export async function listMyResourceRequests(
  userId: string,
  teamId: string,
  limit = 10,
): Promise<MyResourceRequestRow[]> {
  return db
    .select({
      id: approvalRequests.id,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      startTime: approvalRequests.startTime,
      endTime: approvalRequests.endTime,
      status: approvalRequests.status,
      approverName: users.name,
      decidedAt: approvalRequests.decidedAt,
      createdAt: approvalRequests.createdAt,
    })
    .from(approvalRequests)
    .leftJoin(users, eq(approvalRequests.approverId, users.id))
    .where(
      and(
        eq(approvalRequests.requesterId, userId),
        eq(approvalRequests.teamId, teamId),
        eq(approvalRequests.type, "resource_usage"),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(limit);
}
