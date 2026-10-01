import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import type { DbTx } from "@/db";
import {
  labels,
  milestones,
  projects,
  taskDependencies,
  taskLabels,
  tasks,
  teamMembers,
  users,
  type TaskPriority,
  type TaskStatus,
} from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getTeamMembership } from "./team";
import { getProjectForUser } from "./project";
import { notifyTaskAssigned, notifyTaskCompleted } from "./notify";
import { recordTaskActivity } from "./activity";

// 任务写操作角色：admin + student（teacher 只读，设计文档 §5）
const TASK_WRITE_ROLES = ["admin", "student"];

// 动态展示文本：状态/优先级转中文，值存展示文本而非枚举，读端免映射
const STATUS_TEXT: Record<TaskStatus, string> = { todo: "待办", doing: "进行中", done: "已完成" };
const PRIORITY_TEXT: Record<TaskPriority, string> = { low: "低", medium: "中", high: "高" };

// 动态值统一截断，空值归一为「无」
function activityText(v: string | null | undefined, fallback = "无") {
  if (!v || !v.trim()) return fallback;
  return v.length > 200 ? `${v.slice(0, 200)}…` : v;
}

async function requireProjectAccess(actorId: string, projectId: string) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  return access;
}

// 供 lib/label.ts 复用：贴标签属任务写操作，权限口径须与 createTask/updateTask 一致
export async function requireTaskWrite(actorId: string, projectId: string) {
  const access = await requireProjectAccess(actorId, projectId);
  if (!TASK_WRITE_ROLES.includes(access.role)) throw new ForbiddenError();
  return access;
}

async function validateAssignee(teamId: string, assigneeId: string) {
  const membership = await getTeamMembership(assigneeId, teamId);
  if (!membership) throw new AppError("负责人不是团队成员");
}

async function validateMilestone(projectId: string, milestoneId: string) {
  const [m] = await db
    .select({ id: milestones.id })
    .from(milestones)
    .where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, projectId)));
  if (!m) throw new AppError("里程碑不属于该项目");
}

// 父任务须存在且同项目——防跨项目挂载
async function validateParentTask(projectId: string, parentTaskId: string) {
  const [p] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, parentTaskId), eq(tasks.projectId, projectId)));
  if (!p) throw new AppError("父任务不属于该项目");
}

export async function createTask(
  actorId: string,
  projectId: string,
  input: {
    title: string;
    description?: string;
    assigneeId?: string;
    startDate?: string;
    dueDate?: string;
    milestoneId?: string;
    priority?: TaskPriority;
    parentTaskId?: string;
  },
  opts?: { tx?: DbTx },
) {
  const exec = opts?.tx ?? db;
  const access = await requireTaskWrite(actorId, projectId);
  if (input.assigneeId) await validateAssignee(access.project.teamId, input.assigneeId);
  if (input.milestoneId) await validateMilestone(projectId, input.milestoneId);
  if (input.parentTaskId) await validateParentTask(projectId, input.parentTaskId);

  const [task] = await exec
    .insert(tasks)
    .values({
      projectId,
      createdById: actorId,
      title: input.title,
      description: input.description,
      assigneeId: input.assigneeId,
      startDate: input.startDate,
      dueDate: input.dueDate,
      milestoneId: input.milestoneId,
      parentTaskId: input.parentTaskId,
      priority: input.priority ?? "medium",
      sortOrder: Date.now(),
    })
    .returning();

  // 动态：创建记录（传入事务 exec 时同事务写入）
  await recordTaskActivity(exec, [{ taskId: task.id, actorId, type: "created" }]);

  // 非事务路径：即时通知（fire-and-forget，通知内部已吞异常）。事务路径由调用方提交后补发。
  if (!opts?.tx && task.assigneeId) void notifyTaskAssigned(task);
  return task;
}

export async function updateTask(
  actorId: string,
  taskId: string,
  patch: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    startDate?: string | null;
    dueDate?: string | null;
    milestoneId?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    completionNote?: string | null;
  },
  opts?: { tx?: DbTx },
) {
  const exec = opts?.tx ?? db;
  const [task] = await exec.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");

  const access = await requireTaskWrite(actorId, task.projectId);
  if (patch.assigneeId) await validateAssignee(access.project.teamId, patch.assigneeId);
  if (patch.milestoneId) await validateMilestone(task.projectId, patch.milestoneId);

  // 显式白名单构造，勿用 ...patch 展开：运行时宽对象可夹带 projectId/sortOrder 等越权字段
  const [updated] = await exec
    .update(tasks)
    // updatedAt 取 DB 时钟（now()）而非宿主机 new Date()：与 createdAt 的 defaultNow() 同源，保证单调性
    .set({
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.assigneeId !== undefined && { assigneeId: patch.assigneeId }),
      ...(patch.startDate !== undefined && { startDate: patch.startDate }),
      ...(patch.dueDate !== undefined && { dueDate: patch.dueDate }),
      ...(patch.milestoneId !== undefined && { milestoneId: patch.milestoneId }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.priority !== undefined && { priority: patch.priority }),
      ...(patch.completionNote !== undefined && { completionNote: patch.completionNote }),
      updatedAt: sql`now()`,
    })
    .where(eq(tasks.id, taskId))
    .returning();
  if (!updated) throw new AppError("任务不存在");

  // 动态：逐字段 diff，值转展示文本（人名/中文），查询走同一 exec 以兼容事务路径
  const changes: { field: string; oldValue: string; newValue: string }[] = [];

  if (patch.title !== undefined && patch.title !== task.title)
    changes.push({ field: "标题", oldValue: activityText(task.title), newValue: activityText(patch.title) });
  if (patch.description !== undefined && (patch.description ?? null) !== (task.description ?? null))
    changes.push({ field: "描述", oldValue: activityText(task.description), newValue: activityText(patch.description) });
  if (patch.completionNote !== undefined && (patch.completionNote ?? null) !== (task.completionNote ?? null))
    changes.push({ field: "完成情况", oldValue: activityText(task.completionNote), newValue: activityText(patch.completionNote) });
  if (patch.status !== undefined && patch.status !== task.status)
    changes.push({ field: "状态", oldValue: STATUS_TEXT[task.status], newValue: STATUS_TEXT[patch.status] });
  if (patch.priority !== undefined && patch.priority !== task.priority)
    changes.push({ field: "优先级", oldValue: PRIORITY_TEXT[task.priority], newValue: PRIORITY_TEXT[patch.priority] });
  if (patch.startDate !== undefined && (patch.startDate ?? null) !== (task.startDate ?? null))
    changes.push({ field: "起始日", oldValue: activityText(task.startDate), newValue: activityText(patch.startDate) });
  if (patch.dueDate !== undefined && (patch.dueDate ?? null) !== (task.dueDate ?? null))
    changes.push({ field: "截止日", oldValue: activityText(task.dueDate), newValue: activityText(patch.dueDate) });

  if (patch.assigneeId !== undefined && (patch.assigneeId ?? null) !== (task.assigneeId ?? null)) {
    const ids = [task.assigneeId, patch.assigneeId].filter(Boolean) as string[];
    const nameMap = ids.length
      ? new Map(
          (
            await exec
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, ids))
          ).map((r) => [r.id, r.name]),
        )
      : new Map<string, string>();
    changes.push({
      field: "负责人",
      oldValue: task.assigneeId ? (nameMap.get(task.assigneeId) ?? "已移除成员") : "未分配",
      newValue: patch.assigneeId ? (nameMap.get(patch.assigneeId) ?? "未知成员") : "未分配",
    });
  }

  if (patch.milestoneId !== undefined && (patch.milestoneId ?? null) !== (task.milestoneId ?? null)) {
    const ids = [task.milestoneId, patch.milestoneId].filter(Boolean) as string[];
    const titleMap = ids.length
      ? new Map(
          (
            await exec
              .select({ id: milestones.id, title: milestones.title })
              .from(milestones)
              .where(inArray(milestones.id, ids))
          ).map((r) => [r.id, r.title]),
        )
      : new Map<string, string>();
    changes.push({
      field: "里程碑",
      oldValue: task.milestoneId ? (titleMap.get(task.milestoneId) ?? "已删里程碑") : "无里程碑",
      newValue: patch.milestoneId ? (titleMap.get(patch.milestoneId) ?? "未知里程碑") : "无里程碑",
    });
  }

  if (changes.length > 0)
    await recordTaskActivity(
      exec,
      changes.map((c) => ({
        taskId,
        actorId,
        type: "field",
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
      })),
    );

  // 子任务状态跨「已完成」边界时给父任务也记一条，父任务时间线可见子任务进展；
  // 未涉 done 的流转（待办↔进行中）不入父任务动态，避免看板拖拽刷屏
  if (updated.parentTaskId && patch.status !== undefined && patch.status !== task.status) {
    if (patch.status === "done")
      await recordTaskActivity(exec, [
        { taskId: updated.parentTaskId, actorId, type: "subtask_done", newValue: updated.title },
      ]);
    else if (task.status === "done")
      await recordTaskActivity(exec, [
        { taskId: updated.parentTaskId, actorId, type: "subtask_reopened", newValue: updated.title },
      ]);
  }

  if (!opts?.tx) {
    // 改派：通知新负责人
    if (patch.assigneeId && patch.assigneeId !== task.assigneeId) void notifyTaskAssigned(updated);
    // 完成：通知创建者(≠操作者)
    if (patch.status === "done" && task.status !== "done") void notifyTaskCompleted(updated, actorId);
  }
  return updated;
}

export async function deleteTask(actorId: string, taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");
  await requireTaskWrite(actorId, task.projectId);
  // 父任务动态：删除子任务（须先记后删，删后本任务行级联消失、无从补记）
  if (task.parentTaskId)
    await recordTaskActivity(db, [
      { taskId: task.parentTaskId, actorId, type: "subtask_deleted", newValue: task.title },
    ]);
  await db.delete(tasks).where(eq(tasks.id, taskId));
}

export type TaskLabel = { id: string; name: string; color: string };

// 另发一次查询按 taskId 归并，不用 leftJoin：join 会造成行乘积，
// 污染既有 orderBy(sortOrder) 与调用方「一行一任务」的假设。
async function labelsByTask(taskIds: string[]): Promise<Map<string, TaskLabel[]>> {
  const map = new Map<string, TaskLabel[]>();
  if (taskIds.length === 0) return map;

  const rows = await db
    .select({
      taskId: taskLabels.taskId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
    })
    .from(taskLabels)
    .innerJoin(labels, eq(taskLabels.labelId, labels.id))
    .where(inArray(taskLabels.taskId, taskIds))
    .orderBy(labels.name);

  for (const r of rows) {
    const list = map.get(r.taskId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    map.set(r.taskId, list);
  }
  return map;
}

export async function listProjectTasks(actorId: string, projectId: string) {
  await requireProjectAccess(actorId, projectId);
  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      startDate: tasks.startDate,
      dueDate: tasks.dueDate,
      sortOrder: tasks.sortOrder,
      milestoneId: tasks.milestoneId,
      parentTaskId: tasks.parentTaskId,
      assigneeId: tasks.assigneeId,
      assigneeName: users.name,
      updatedAt: tasks.updatedAt,
      completionNote: tasks.completionNote,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeId, users.id))
    .where(eq(tasks.projectId, projectId))
    .orderBy(tasks.sortOrder);

  const byTask = await labelsByTask(rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, labels: byTask.get(r.id) ?? [] }));
}

// 列某任务之下的子任务（直接子级，不递归）
export async function listSubtasks(actorId: string, parentTaskId: string) {
  const [parent] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, parentTaskId));
  if (!parent) throw new AppError("任务不存在");
  await requireProjectAccess(actorId, parent.projectId);

  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      description: tasks.description,
      status: tasks.status,
      priority: tasks.priority,
      startDate: tasks.startDate,
      dueDate: tasks.dueDate,
      milestoneId: tasks.milestoneId,
      parentTaskId: tasks.parentTaskId,
      assigneeId: tasks.assigneeId,
      assigneeName: users.name,
      completionNote: tasks.completionNote,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeId, users.id))
    .where(eq(tasks.parentTaskId, parentTaskId))
    .orderBy(tasks.sortOrder);
}

// 在某任务下建子任务：projectId 由父任务推得，调用方无须再传。
// 新建行必无既有子级，故不可能成环，无须环检测。
export async function createSubtask(
  actorId: string,
  parentTaskId: string,
  input: {
    title: string;
    description?: string;
    assigneeId?: string;
    startDate?: string;
    dueDate?: string;
    milestoneId?: string;
    priority?: TaskPriority;
  },
) {
  const [parent] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, parentTaskId));
  if (!parent) throw new AppError("任务不存在");
  const subtask = await createTask(actorId, parent.projectId, { ...input, parentTaskId });
  // 父任务动态：添加子任务（子任务自身已有 created 记录）
  await recordTaskActivity(db, [
    { taskId: parentTaskId, actorId, type: "subtask_added", newValue: subtask.title },
  ]);
  return subtask;
}

// 单任务详情（供 Agent API 按 id 直取）。权限口径同 listProjectTasks：项目成员即可读。
// 注：「任务不存在」先于权限返回，沿既有 updateTask/deleteTask 之口径（BACKLOG 已录此债）。
export async function getTaskDetail(actorId: string, taskId: string) {
  const [row] = await db
    .select({
      id: tasks.id,
      projectId: tasks.projectId,
      title: tasks.title,
      description: tasks.description,
      completionNote: tasks.completionNote,
      status: tasks.status,
      priority: tasks.priority,
      startDate: tasks.startDate,
      dueDate: tasks.dueDate,
      milestoneId: tasks.milestoneId,
      parentTaskId: tasks.parentTaskId,
      assigneeId: tasks.assigneeId,
      assigneeName: users.name,
      updatedAt: tasks.updatedAt,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .leftJoin(users, eq(tasks.assigneeId, users.id))
    .where(eq(tasks.id, taskId));
  if (!row) throw new AppError("任务不存在");
  await requireProjectAccess(actorId, row.projectId);
  const byTask = await labelsByTask([row.id]);
  return { ...row, labels: byTask.get(row.id) ?? [] };
}

// 设置 predecessor 的后置任务（先删旧再插新）。简单关联：仅防直接成环，不强制阻断执行。
export async function setTaskSuccessors(
  actorId: string,
  predecessorId: string,
  successorIds: string[],
) {
  const [pred] = await db.select().from(tasks).where(eq(tasks.id, predecessorId));
  if (!pred) throw new AppError("任务不存在");
  await requireTaskWrite(actorId, pred.projectId);

  for (const sid of successorIds) {
    if (sid === predecessorId) throw new AppError("后置任务不可构成循环");
    const [s] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, sid));
    if (!s || s.projectId !== pred.projectId)
      throw new AppError("后置任务不属于该项目");
    const [back] = await db
      .select({ id: taskDependencies.id })
      .from(taskDependencies)
      .where(
        and(
          eq(taskDependencies.predecessorId, sid),
          eq(taskDependencies.successorId, predecessorId),
        ),
      );
    if (back) throw new AppError("后置任务不可构成循环");
  }

  await db.transaction(async (tx) => {
    await tx.delete(taskDependencies).where(eq(taskDependencies.predecessorId, predecessorId));
    if (successorIds.length > 0) {
      await tx
        .insert(taskDependencies)
        .values(successorIds.map((sid) => ({ predecessorId, successorId: sid })));
    }
  });
}

export async function listProjectDependencies(actorId: string, projectId: string) {
  await requireProjectAccess(actorId, projectId);
  return db
    .select({
      predecessorId: taskDependencies.predecessorId,
      successorId: taskDependencies.successorId,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.predecessorId, tasks.id))
    .where(eq(tasks.projectId, projectId));
}

// 工作台：跨全部项目列「分配给我的父任务」（子任务不上看板，经父卡片的子任务进度体现）。
// inner join teamMembers 直取访问者在任务所属团队的角色（前端据此判定该卡可否拖拽），
// 同时充当成员资格过滤：被移出团队后任务即不出现，与 getProjectForUser 读权限口径一致。
export async function listMyTasks(actorId: string) {
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      dueDate: tasks.dueDate,
      sortOrder: tasks.sortOrder,
      projectId: projects.id,
      projectName: projects.name,
      role: teamMembers.role,
    })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, actorId)),
    )
    .where(
      and(
        eq(tasks.assigneeId, actorId),
        eq(projects.status, "active"),
        isNull(tasks.parentTaskId),
      ),
    )
    // PG ASC 默认 NULLS LAST：无截止日的任务排最后
    .orderBy(tasks.dueDate, tasks.sortOrder);
}

// 工作台子任务进度：给定父任务 id 集合（= listMyTasks 的返回），按父聚合直接子级的总数与完成数。
// 只算直接子级（与 listSubtasks 口径一致，不递归）；不按子任务负责人过滤——父任务的进度看整体。
export type SubtaskProgressRow = { parentTaskId: string; total: number; done: number };

export async function listMySubtaskProgress(parentTaskIds: string[]) {
  if (parentTaskIds.length === 0) return [];
  return db
    .select({
      parentTaskId: tasks.parentTaskId,
      total: sql<number>`count(*)::int`,
      done: sql<number>`(count(*) filter (where ${tasks.status} = 'done'))::int`,
    })
    .from(tasks)
    .where(inArray(tasks.parentTaskId, parentTaskIds))
    .groupBy(tasks.parentTaskId);
}
