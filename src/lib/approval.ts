/**
 * 审批流：成员发起、**拥有对应审核权限**的成员审批（任一通过即生效）。
 *
 * 三类申请：
 * - task_done：学生把任务标成完成（含待办直跳）时由 lib/task.ts 拦截转申请，
 *   任务保持未完成直至通过；同任务同时最多一条 pending（partial unique index 兜底）。
 * - resource_usage：无资源审核权的成员登记占用转为申请，**通过时才建占用行**；
 *   有权者登记沿用原直登路径，不经审批。
 * - project_acceptance：成员为项目申请结题验收，项目保持 active 直至通过；
 *   有验收权者可在项目页直接结题（completeProjectDirectly，不经申请）。
 *   结题前任务必须全部完成（申请时与通过时双重校验）；恢复进行中
 * （reopenProject）只把项目置回 active，任务保持已完成。
 *
 * 审批人口径（lib/team-permissions.ts）：admin 天然拥有全部三项权限，其余成员
 * 由团队管理员在权限页按人勾选。通知走站内**系统消息**：申请时提醒有对应权限
 * 的人、决定后回执申请人（拒绝原因随回执带给申请人）。
 */
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
} from "@/db/schema";
import { AppError, ForbiddenError, isUniqueViolation } from "./errors";
import { DECISION_NOTE_MAX_LENGTH } from "./approval-view";
import { getTeamMembership } from "./team";
import {
  hasPermission,
  listPermissionHolders,
  type TeamPermission,
} from "./team-permissions";
import { recordTaskActivity } from "./activity";
import { notifyTaskCompleted } from "./notify";

export type ApprovalDecision = "approved" | "rejected";

/** 申请类型 → 所需审核权限 */
const PERMISSION_BY_TYPE: Record<ApprovalType, TeamPermission> = {
  task_done: "task_done",
  resource_usage: "resource",
  project_acceptance: "project",
};

/** 成员能决定这类申请吗（admin 恒可；其余按勾选） */
export function canDecideType(
  membership: { role: "admin" | "teacher" | "student"; canApproveTaskDone: boolean; canApproveResource: boolean; canAcceptProject: boolean },
  type: ApprovalType,
): boolean {
  return hasPermission(membership.role, membership, PERMISSION_BY_TYPE[type]);
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

/** 我在任一团队拥有任一审核权限吗（工作台默认布局与资源表单文案据此分流） */
export async function isApproverAnywhere(actorId: string): Promise<boolean> {
  const rows = await db
    .select({
      role: teamMembers.role,
      canApproveTaskDone: teamMembers.canApproveTaskDone,
      canApproveResource: teamMembers.canApproveResource,
      canAcceptProject: teamMembers.canAcceptProject,
    })
    .from(teamMembers)
    .where(eq(teamMembers.userId, actorId));
  return rows.some(
    (r) =>
      r.role === "admin" || r.canApproveTaskDone || r.canApproveResource || r.canAcceptProject,
  );
}

/**
 * 工作台「待办审批」卡片：我在哪些团队对哪类申请有审核权，就列那些团队里
 * 对应类型的 pending 申请（admin 所在团队三类全列）。最先提交的最先处理
 * （createdAt 升序），上限 20 条。
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
  /** type=project_acceptance 时的项目名（task_done 用任务名，资源用资源名） */
  projectName: string | null;
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
  const memberships = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      canApproveTaskDone: teamMembers.canApproveTaskDone,
      canApproveResource: teamMembers.canApproveResource,
      canAcceptProject: teamMembers.canAcceptProject,
    })
    .from(teamMembers)
    .where(eq(teamMembers.userId, actorId));
  if (memberships.length === 0) return [];

  // 每类申请我有权处理的团队集合；admin 所在团队三类全收
  const teamsFor = (perm: TeamPermission) =>
    memberships
      .filter((m) => hasPermission(m.role, m, perm))
      .map((m) => m.teamId);
  const taskTeams = teamsFor("task_done");
  const resourceTeams = teamsFor("resource");
  const projectTeams = teamsFor("project");
  const scope = or(
    (taskTeams.length && and(inArray(approvalRequests.teamId, taskTeams), eq(approvalRequests.type, "task_done"))) ||
      undefined,
    (resourceTeams.length &&
      and(inArray(approvalRequests.teamId, resourceTeams), eq(approvalRequests.type, "resource_usage"))) ||
      undefined,
    (projectTeams.length &&
      and(
        inArray(approvalRequests.teamId, projectTeams),
        eq(approvalRequests.type, "project_acceptance"),
      )) ||
      undefined,
  );
  if (!scope) return [];

  const rows = await db
    .select({
      id: approvalRequests.id,
      type: approvalRequests.type,
      teamId: approvalRequests.teamId,
      teamName: teams.name,
      requesterId: approvalRequests.requesterId,
      requesterName: users.name,
      taskId: approvalRequests.taskId,
      taskTitle: tasks.title,
      taskProjectId: tasks.projectId,
      projectId: approvalRequests.projectId,
      projectName: projects.name,
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
    .leftJoin(projects, eq(approvalRequests.projectId, projects.id))
    .where(and(eq(approvalRequests.status, "pending"), scope))
    .orderBy(asc(approvalRequests.createdAt))
    .limit(limit);

  return rows.map(({ taskProjectId, ...r }) => ({
    ...r,
    // task_done 的项目来自任务行；project_acceptance 的项目在申请行自己身上
    projectId: r.projectId ?? taskProjectId,
  }));
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
  const holderIds = await listPermissionHolders(task.teamId, "task_done", exec);
  for (const holderId of holderIds) {
    if (holderId === actorId) continue;
    await notifySystemSafe(holderId, requestId!, content, exec);
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
 * 无资源审核权的成员登记资源占用 → 转为审批申请（通过时才建占用行）。
 * 有权者不走这里：resources 的 action 层按权限分流到 createResourceUsage 直登。
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
  const holderIds = await listPermissionHolders(teamId, "resource");
  for (const holderId of holderIds) {
    if (holderId === actorId) continue;
    await notifySystemSafe(holderId, requestId, content);
  }
}

/**
 * 成员为项目申请结题验收：项目保持 active 直至有验收权者通过。
 * 有未完成的任务时不予受理（先把活干完）；同一项目同时最多一条 pending
 * （partial unique index 兜底）。结题说明复用 purpose 列（资源用途同款快照位）。
 */
export async function requestProjectAcceptance(
  actorId: string,
  projectId: string,
  note?: string | null,
): Promise<void> {
  const [project] = await db
    .select({ id: projects.id, name: projects.name, status: projects.status, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError("项目不存在");
  const membership = await getTeamMembership(actorId, project.teamId);
  if (!membership) throw new ForbiddenError();
  if (project.status !== "active") throw new AppError("项目不在进行中，无须申请结题");

  const [open] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), ne(tasks.status, "done")));
  if (open && open.count > 0)
    throw new AppError(`还有 ${open.count} 个任务未完成，全部完成后再申请结题`);

  let requestId: string;
  try {
    const [row] = await db
      .insert(approvalRequests)
      .values({
        teamId: project.teamId,
        requesterId: actorId,
        type: "project_acceptance",
        projectId,
        purpose: note?.trim() || null,
      })
      .returning({ id: approvalRequests.id });
    requestId = row.id;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("该项目已有待审批的结题申请");
    throw e;
  }

  const [requester] = await db.select({ name: users.name }).from(users).where(eq(users.id, actorId));
  const content = `【结题验收】${requester?.name ?? "有成员"} 申请为项目「${project.name}」结题验收`;
  const holderIds = await listPermissionHolders(project.teamId, "project");
  for (const holderId of holderIds) {
    if (holderId === actorId) continue;
    await notifySystemSafe(holderId, requestId, content);
  }
}

/**
 * 结题前置校验：任务必须全部完成。审批通过时在事务里再查一次——
 * 申请未决期间任务可能被挪回未完成，届时拒绝通过（回滚决定）。
 */
async function assertProjectTasksDone(tx: DbTx, projectId: string): Promise<void> {
  const [open] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), ne(tasks.status, "done")));
  if (open && open.count > 0)
    throw new AppError(`还有 ${open.count} 个任务未完成，无法结题`);
}

/**
 * 有验收权者（admin 或被勾选者）直接把项目标为已结题，不经申请。
 * 未决的结题申请随之作废（与任务完成的「管理员直接完成=申请被替代」同口径）。
 */
export async function completeProjectDirectly(actorId: string, projectId: string): Promise<void> {
  const [project] = await db
    .select({ id: projects.id, status: projects.status, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError("项目不存在");
  const membership = await getTeamMembership(actorId, project.teamId);
  if (!membership || !hasPermission(membership.role, membership, "project"))
    throw new ForbiddenError("没有项目结题验收权限");
  if (project.status !== "active") throw new AppError("项目不在进行中，无法结题");

  await db.transaction(async (tx) => {
    await assertProjectTasksDone(tx, projectId);
    await tx
      .delete(approvalRequests)
      .where(
        and(
          eq(approvalRequests.projectId, projectId),
          eq(approvalRequests.status, "pending"),
          eq(approvalRequests.type, "project_acceptance"),
        ),
      );
    await tx.update(projects).set({ status: "completed" }).where(eq(projects.id, projectId));
  });
}

/**
 * 有验收权者把已结题项目恢复为进行中。任务保持已完成状态
 * （结题前任务本就全部完成，无可回溯），只是项目重新回到 active。
 */
export async function reopenProject(actorId: string, projectId: string): Promise<void> {
  const [project] = await db
    .select({ status: projects.status, teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new AppError("项目不存在");
  const membership = await getTeamMembership(actorId, project.teamId);
  if (!membership || !hasPermission(membership.role, membership, "project"))
    throw new ForbiddenError("没有项目结题验收权限");
  if (project.status !== "completed") throw new AppError("项目不在已结题状态，无法恢复");

  await db.update(projects).set({ status: "active" }).where(eq(projects.id, projectId));
}

/** 这些项目有未决的结题申请（团队项目页/项目页的「结题审批中」徽章用） */
export async function listPendingAcceptanceProjectIds(
  projectIds: string[],
): Promise<Set<string>> {
  if (projectIds.length === 0) return new Set();
  const rows = await db
    .select({ projectId: approvalRequests.projectId })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.status, "pending"),
        eq(approvalRequests.type, "project_acceptance"),
        inArray(approvalRequests.projectId, projectIds),
      ),
    );
  return new Set(rows.map((r) => r.projectId).filter((id): id is string => id != null));
}

// —— 决定 ——

/**
 * 审批决定：对 pending 申请，**拥有对应审核权限且非申请人本人**的成员给出通过或拒绝。
 *
 * 决定与业务写入同事务；两个审批人并发点同一条时靠「带 pending 条件的 UPDATE」
 * 原子抢占，后到者收到「该审批已被处理」。私信回执在事务提交后发（失败不回滚决定）。
 *
 * 通过 task_done：任务补成 done（须仍未完成，状态已漂移则报错）+ 动态 + 完成通知；
 * 通过 resource_usage：按快照建占用行（占用人 = 申请人）；
 * 通过 project_acceptance：项目置为 completed（须仍是 active 且任务全部完成）。
 */
export async function decideApproval(
  actorId: string,
  requestId: string,
  decision: ApprovalDecision,
  note?: string | null,
): Promise<void> {
  // 拒绝原因由审批人随手填，留空即沿用通用文案；超长截断避免撑爆消息卡片
  const decisionNote =
    decision === "rejected" && note?.trim() ? note.trim().slice(0, DECISION_NOTE_MAX_LENGTH) : null;
  const [request] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, requestId));
  if (!request) throw new AppError("审批不存在");

  const membership = await getTeamMembership(actorId, request.teamId);
  if (!membership || !canDecideType(membership, request.type)) throw new ForbiddenError();
  // 自己发起的申请自己批等于没审（权限可授予学生，此门必须关）
  if (request.requesterId === actorId) throw new AppError("不能审批自己发起的申请");

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
      .set({
        status: decision,
        approverId: actorId,
        decidedAt: sql`now()`,
        decisionNote,
      })
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
    } else if (decided.type === "project_acceptance") {
      const [project] = await tx
        .select({ id: projects.id, name: projects.name, status: projects.status })
        .from(projects)
        .where(eq(projects.id, decided.projectId!));
      if (!project) throw new AppError("项目已不存在");
      objectText = `结题验收的项目「${project.name}」`;
      if (decision === "approved") {
        // 申请未决期间项目可能被直接结题/归档、任务可能被挪回未完成，漂移则拒绝通过（回滚决定）
        if (project.status !== "active") throw new AppError("项目状态已变化，无法通过该审批");
        await assertProjectTasksDone(tx, project.id);
        await tx.update(projects).set({ status: "completed" }).where(eq(projects.id, project.id));
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
      : decisionNote
        ? `【审批被拒】你申请${objectText}未获通过（审批人：${approverName}）。拒绝原因：${decisionNote}`
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
  /** 申请所在团队：任务完成与资源占用都能据此拼出「跳转」目标 */
  teamId: string;
  taskId: string | null;
  projectId: string | null;
  taskTitle: string | null;
  /** type=project_acceptance 时的项目名 */
  projectName: string | null;
  resourceName: string | null;
  purpose: string | null;
  startTime: Date | null;
  endTime: Date | null;
  requesterName: string;
  canDecide: boolean;
  /** 审批人拒绝时填写的原因（通过/未决为空） */
  decisionNote: string | null;
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
      requesterId: approvalRequests.requesterId,
      taskId: approvalRequests.taskId,
      taskProjectId: tasks.projectId,
      projectId: approvalRequests.projectId,
      projectName: projects.name,
      taskTitle: tasks.title,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      startTime: approvalRequests.startTime,
      endTime: approvalRequests.endTime,
      requesterName: users.name,
      decisionNote: approvalRequests.decisionNote,
    })
    .from(systemMessages)
    .innerJoin(approvalRequests, eq(systemMessages.approvalId, approvalRequests.id))
    .innerJoin(users, eq(approvalRequests.requesterId, users.id))
    .leftJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .leftJoin(projects, eq(approvalRequests.projectId, projects.id))
    .where(eq(systemMessages.userId, userId))
    .orderBy(desc(systemMessages.createdAt))
    .limit(limit);

  if (rows.length === 0) return [];

  // canDecide：批量取我在涉及团队里的完整成员行（含权限勾选），按申请类型逐行判
  //（admin 恒可，其余按勾选；申请人本人恒不可——自己不能批自己的申请）
  const teamIds = [...new Set(rows.map((r) => r.teamId))];
  const myMemberships = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      canApproveTaskDone: teamMembers.canApproveTaskDone,
      canApproveResource: teamMembers.canApproveResource,
      canAcceptProject: teamMembers.canAcceptProject,
    })
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), inArray(teamMembers.teamId, teamIds)));
  const membershipByTeam = new Map(myMemberships.map((r) => [r.teamId, r]));
  const noMembership = {
    role: "student" as const,
    canApproveTaskDone: false,
    canApproveResource: false,
    canAcceptProject: false,
  };

  return rows.map((r) => ({
    id: r.id,
    approvalId: r.approvalId,
    content: r.content,
    readAt: r.readAt,
    createdAt: r.createdAt,
    approvalType: r.approvalType,
    approvalStatus: r.approvalStatus,
    teamId: r.teamId,
    taskId: r.taskId,
    projectId: r.projectId ?? r.taskProjectId,
    taskTitle: r.taskTitle,
    projectName: r.projectName,
    resourceName: r.resourceName,
    purpose: r.purpose,
    startTime: r.startTime,
    endTime: r.endTime,
    requesterName: r.requesterName,
    canDecide:
      r.approvalStatus === "pending" &&
      r.requesterId !== userId &&
      canDecideType(membershipByTeam.get(r.teamId) ?? noMembership, r.approvalType),
    decisionNote: r.decisionNote,
  }));
}

export async function countUnreadSystemMessages(userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(systemMessages)
    .where(and(eq(systemMessages.userId, userId), isNull(systemMessages.readAt)));
  return row?.count ?? 0;
}

/** 打开系统消息会话即全部置读（与 dm 打开会话即已读的口径一致） */
export async function markSystemMessagesRead(userId: string): Promise<void> {
  await db
    .update(systemMessages)
    .set({ readAt: sql`now()` })
    .where(and(eq(systemMessages.userId, userId), isNull(systemMessages.readAt)));
}

/**
 * 审批详情：审批人弹小窗查看申请内容（任务完成说明+附件 / 资源申请快照 / 结题说明），
 * 申请人本人也可回看结果。权限：该审批所在团队里**拥有对应审核权限**的成员，或申请人本人。
 */
export type ApprovalDetail = {
  approvalId: string;
  type: ApprovalType;
  status: ApprovalStatus;
  requesterName: string;
  taskId: string | null;
  projectId: string | null;
  taskTitle: string | null;
  /** type=project_acceptance 时的项目名 */
  projectName: string | null;
  resourceName: string | null;
  purpose: string | null;
  // 资源申请快照的起止时间（任务完成申请为 null）
  startTime: Date | null;
  endTime: Date | null;
  completionNote: string | null;
  decidedAt: Date | null;
  approverName: string | null;
  /** 拒绝原因（审批人填写；通过或未决为空） */
  decisionNote: string | null;
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
      taskProjectId: tasks.projectId,
      projectId: approvalRequests.projectId,
      projectName: projects.name,
      taskTitle: tasks.title,
      completionNote: tasks.completionNote,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      startTime: approvalRequests.startTime,
      endTime: approvalRequests.endTime,
      decidedAt: approvalRequests.decidedAt,
      decisionNote: approvalRequests.decisionNote,
    })
    .from(approvalRequests)
    .innerJoin(users, eq(approvalRequests.requesterId, users.id))
    .leftJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .leftJoin(projects, eq(approvalRequests.projectId, projects.id))
    .where(eq(approvalRequests.id, approvalId));
  if (!row) throw new AppError("审批不存在");

  if (row.requesterId !== actorId) {
    const membership = await getTeamMembership(actorId, row.teamId);
    if (!membership || !canDecideType(membership, row.type)) throw new ForbiddenError();
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
    // task_done 的项目来自任务行；project_acceptance 的项目在申请行自己身上
    projectId: row.projectId ?? row.taskProjectId,
    taskTitle: row.taskTitle,
    projectName: row.projectName,
    resourceName: row.resourceName,
    purpose: row.purpose,
    startTime: row.startTime,
    endTime: row.endTime,
    completionNote: row.completionNote,
    decidedAt: row.decidedAt,
    approverName,
    decisionNote: row.decisionNote,
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

/**
 * 工作台看板「审批记录」弹窗：与我有关的全部审批（我发起的 + 我审批过的），
 * 倒序。学生只看得到自己发起的；老师/管理员两种方向都能看到，客户端按
 * direction 分组展示。决定时间、拒绝原因一并带回，作为「回复」列。
 */
export type ApprovalHistoryRow = {
  id: string;
  type: ApprovalType;
  status: ApprovalStatus;
  /** requested = 我发起；decided = 我审批 */
  direction: "requested" | "decided";
  teamId: string;
  teamName: string;
  requesterName: string;
  approverName: string | null;
  taskId: string | null;
  projectId: string | null;
  taskTitle: string | null;
  /** type=project_acceptance 时的项目名 */
  projectName: string | null;
  resourceName: string | null;
  purpose: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
};

export async function listMyApprovalHistory(
  userId: string,
  limit = 50,
): Promise<ApprovalHistoryRow[]> {
  const requester = alias(users, "requester");
  const approver = alias(users, "approver");

  const rows = await db
    .select({
      id: approvalRequests.id,
      type: approvalRequests.type,
      status: approvalRequests.status,
      requesterId: approvalRequests.requesterId,
      teamId: approvalRequests.teamId,
      teamName: teams.name,
      requesterName: requester.name,
      approverName: approver.name,
      taskId: approvalRequests.taskId,
      taskProjectId: tasks.projectId,
      projectId: approvalRequests.projectId,
      projectName: projects.name,
      taskTitle: tasks.title,
      resourceName: approvalRequests.resourceName,
      purpose: approvalRequests.purpose,
      createdAt: approvalRequests.createdAt,
      decidedAt: approvalRequests.decidedAt,
      decisionNote: approvalRequests.decisionNote,
    })
    .from(approvalRequests)
    .innerJoin(teams, eq(approvalRequests.teamId, teams.id))
    .innerJoin(requester, eq(approvalRequests.requesterId, requester.id))
    .leftJoin(approver, eq(approvalRequests.approverId, approver.id))
    .leftJoin(tasks, eq(approvalRequests.taskId, tasks.id))
    .leftJoin(projects, eq(approvalRequests.projectId, projects.id))
    .where(
      or(
        eq(approvalRequests.requesterId, userId),
        eq(approvalRequests.approverId, userId),
      ),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(limit);

  return rows.map(({ requesterId, taskProjectId, ...r }) => ({
    ...r,
    projectId: r.projectId ?? taskProjectId,
    direction: requesterId === userId ? "requested" : "decided",
  }));
}
