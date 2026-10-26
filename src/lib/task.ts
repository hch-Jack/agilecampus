import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
import { AppError, ApprovalRequestedError, ForbiddenError } from "./errors";
import { getTeamMembership } from "./team";
import { getProjectForUser, validateDateRange } from "./project";
import { notifyTaskAssigned, notifyTaskCompleted } from "./notify";
import { recordTaskActivity } from "./activity";
import { requestTaskCompletion, withdrawTaskApprovals } from "./approval";

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

// 供 lib/label.ts 复用：贴标签属任务写操作，权限口径须与 createTask/updateTask 一致。
// approvedBy：仅审批通过路径（decideApproval）使用——审批人可能是只读的 teacher，
// 写权限已由审批流验证（老师/管理员任一通过），这里豁免写角色检查但保留成员校验。
export async function requireTaskWrite(
  actorId: string,
  projectId: string,
  opts?: { tx?: DbTx; approvedBy?: boolean },
) {
  const access = await requireProjectAccess(actorId, projectId);
  if (!opts?.approvedBy && !TASK_WRITE_ROLES.includes(access.role)) throw new ForbiddenError();
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

// 任务日期校验（lib 收口，口径同 createProject）：先后顺序 + 须落在项目周期内。
// 项目任一侧未设周期则该侧不设限；ISO 日期字典序即时间序，边界日（等于项目起/止）合法。
// createTask 传 undefined（未填），updateTask 合并库中既有值后可传 null（清空）。
function validateTaskDates(
  project: { startDate: string | null; endDate: string | null },
  startDate?: string | null,
  dueDate?: string | null,
) {
  validateDateRange(startDate, dueDate);
  if (startDate) {
    if (project.startDate && startDate < project.startDate)
      throw new AppError("开始日期不能早于项目开始日期");
    if (project.endDate && startDate > project.endDate)
      throw new AppError("开始日期不能晚于项目结束日期");
  }
  if (dueDate) {
    if (project.startDate && dueDate < project.startDate)
      throw new AppError("结束日期不能早于项目开始日期");
    if (project.endDate && dueDate > project.endDate)
      throw new AppError("结束日期不能晚于项目结束日期");
  }
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
    /** 完成是否需要审批；缺省 true（沿用既有审批口径） */
    requireApproval?: boolean;
  },
  opts?: { tx?: DbTx },
) {
  const exec = opts?.tx ?? db;
  const access = await requireTaskWrite(actorId, projectId);
  if (input.assigneeId) await validateAssignee(access.project.teamId, input.assigneeId);
  if (input.milestoneId) await validateMilestone(projectId, input.milestoneId);
  if (input.parentTaskId) await validateParentTask(projectId, input.parentTaskId);
  validateTaskDates(access.project, input.startDate, input.dueDate);

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
      requireApproval: input.requireApproval ?? true,
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
  opts?: { tx?: DbTx; approvedBy?: boolean },
) {
  const exec = opts?.tx ?? db;
  const [task] = await exec.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");

  const access = await requireTaskWrite(actorId, task.projectId, opts);
  if (patch.assigneeId) await validateAssignee(access.project.teamId, patch.assigneeId);
  if (patch.milestoneId) await validateMilestone(task.projectId, patch.milestoneId);
  // 日期校验（口径同 createTask）：patch 只带一侧时与库中另一侧合并成对再验；
  // 仅在 patch 触及日期时才验，放行历史越界数据对不相关字段的编辑
  if (patch.startDate !== undefined || patch.dueDate !== undefined) {
    validateTaskDates(
      access.project,
      patch.startDate !== undefined ? patch.startDate : task.startDate,
      patch.dueDate !== undefined ? patch.dueDate : task.dueDate,
    );
  }

  // —— 完成审批拦截 ——
  // 学生把**顶层任务**标成 done（含待办直跳完成，堵住绕过审批的口子）：不直接改
  // 状态，转成完成审批申请（老师/管理员任一通过才算完成）。子任务不拦（进度颗粒
  // 太细，审批只看父任务）；teacher 只读本就改不了；管理员/老师操作即审批者本人。
  // requireApproval=false 的任务是创建时明确勾掉审批的，学生可直接完成。
  const completionNeedsApproval =
    patch.status === "done" &&
    task.status !== "done" &&
    !task.parentTaskId &&
    task.requireApproval &&
    access.role === "student";

  // 状态落定前撤掉未决的完成申请：拖回待办/进行中=申请人撤回；管理员直接完成=申请被替代；
  // 从待审核列拖回原状态列（如进行中）也算撤回，故只看「显式改了顶层任务状态」不看新旧值是否不同
  if (patch.status !== undefined && !task.parentTaskId && !completionNeedsApproval) {
    await withdrawTaskApprovals(taskId, exec);
  }

  // 被拦截时其他字段照常应用，唯独 status 不动
  const updatePatch = completionNeedsApproval ? { ...patch, status: undefined } : patch;

  // 显式白名单构造，勿用 ...patch 展开：运行时宽对象可夹带 projectId/sortOrder 等越权字段
  const [updated] = await exec
    .update(tasks)
    // updatedAt 取 DB 时钟（now()）而非宿主机 new Date()：与 createdAt 的 defaultNow() 同源，保证单调性
    .set({
      ...(updatePatch.title !== undefined && { title: updatePatch.title }),
      ...(updatePatch.description !== undefined && { description: updatePatch.description }),
      ...(updatePatch.assigneeId !== undefined && { assigneeId: updatePatch.assigneeId }),
      ...(updatePatch.startDate !== undefined && { startDate: updatePatch.startDate }),
      ...(updatePatch.dueDate !== undefined && { dueDate: updatePatch.dueDate }),
      ...(updatePatch.milestoneId !== undefined && { milestoneId: updatePatch.milestoneId }),
      ...(updatePatch.status !== undefined && { status: updatePatch.status }),
      ...(updatePatch.priority !== undefined && { priority: updatePatch.priority }),
      ...(updatePatch.completionNote !== undefined && { completionNote: updatePatch.completionNote }),
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
  // 状态 diff 用 updatePatch：学生完成被审批拦截时状态实际未变，不该记「已完成」
  if (updatePatch.status !== undefined && updatePatch.status !== task.status)
    changes.push({ field: "状态", oldValue: STATUS_TEXT[task.status], newValue: STATUS_TEXT[updatePatch.status] });
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

  // 父任务完成时级联完成所有未完成子任务（看板把父卡拖进「已完成」也走这里）。
  // 用 updatePatch 判断：学生提交完成申请被拦截时状态未落定，子任务**不**提前完成，
  // 各自保持原状——审批通过（此刻 updatePatch.status=done）才级联，被拒即原样退回。
  // 递归沿用同一个 exec / 事务：子级照常写自己的状态动态，并给本任务补 subtask_done。
  // 只单向级联，父任务被拖回待办时不会把子任务重新打开。
  if (updatePatch.status === "done" && task.status !== "done") {
    const openChildren = await exec
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.parentTaskId, taskId), ne(tasks.status, "done")));
    for (const child of openChildren) {
      await updateTask(actorId, child.id, { status: "done" }, opts);
    }
  }

  // 子任务状态跨「已完成」边界时给父任务也记一条，父任务时间线可见子任务进展；
  // 未涉 done 的流转（待办↔进行中）不入父任务动态，避免看板拖拽刷屏
  if (updated.parentTaskId && updatePatch.status !== undefined && updatePatch.status !== task.status) {
    if (updatePatch.status === "done")
      await recordTaskActivity(exec, [
        { taskId: updated.parentTaskId, actorId, type: "subtask_done", newValue: updated.title },
      ]);
    else if (task.status === "done")
      await recordTaskActivity(exec, [
        { taskId: updated.parentTaskId, actorId, type: "subtask_reopened", newValue: updated.title },
      ]);
  }

  if (completionNeedsApproval) {
    // 申请行 + 动态随本次事务（或连接池）落库（其他字段的 diff 已照记，唯独状态没变）；
    // 非事务路径抛错中断，看板据此回弹卡片并展示提示；事务路径（助手批量应用）返回
    // 未完成任务行，调用方按返回状态判断，committed 计数把这类任务算进去是已知取舍。
    await recordTaskActivity(exec, [{ taskId, actorId, type: "approval_requested" }]);
    await requestTaskCompletion(actorId, taskId, exec);
    if (!opts?.tx) throw new ApprovalRequestedError();
    return updated;
  }

  if (!opts?.tx) {
    // 改派：通知新负责人
    if (updatePatch.assigneeId && updatePatch.assigneeId !== task.assigneeId) void notifyTaskAssigned(updated);
    // 完成：通知创建者(≠操作者)。审批拦截路径 status 未变（updatePatch 无 status），不会误发
    if (updatePatch.status === "done" && task.status !== "done") void notifyTaskCompleted(updated, actorId);
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
      requireApproval: tasks.requireApproval,
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
      requireApproval: tasks.requireApproval,
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

function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

// 设置 predecessor 的后置任务（先删旧再插新）。
// 后置任务须与前置任务同级（同一父任务；顶层任务彼此同级）；
// 自环与直接/间接环一律拒绝，避免流程图里出现新的环。
export async function setTaskSuccessors(
  actorId: string,
  predecessorId: string,
  successorIds: string[],
  opts?: { preserveCrossLevelIfSiblingSetUnchanged?: boolean },
) {
  const [pred] = await db.select().from(tasks).where(eq(tasks.id, predecessorId));
  if (!pred) throw new AppError("任务不存在");
  await requireTaskWrite(actorId, pred.projectId);

  const uniqueIds = [...new Set(successorIds)];

  // 历史跨层级后置边不在编辑候选列表里。若本次提交的同级集合与库中一致，
  // 说明用户没有改动后置任务，跳过整表替换，避免只改标题/日期时误删历史边。
  if (opts?.preserveCrossLevelIfSiblingSetUnchanged) {
    const current = await db
      .select({
        successorId: taskDependencies.successorId,
        parentTaskId: tasks.parentTaskId,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.successorId, tasks.id))
      .where(eq(taskDependencies.predecessorId, predecessorId));
    const currentSiblingIds = current
      .filter((row) => row.parentTaskId === pred.parentTaskId)
      .map((row) => row.successorId);
    if (sameIdSet(currentSiblingIds, uniqueIds)) return;
  }

  if (uniqueIds.includes(predecessorId))
    throw new AppError("后置任务不可构成循环");

  const successors = uniqueIds.length
    ? await db
        .select({
          id: tasks.id,
          projectId: tasks.projectId,
          parentTaskId: tasks.parentTaskId,
        })
        .from(tasks)
        .where(inArray(tasks.id, uniqueIds))
    : [];

  if (
    successors.length !== uniqueIds.length ||
    successors.some((s) => s.projectId !== pred.projectId)
  )
    throw new AppError("后置任务不属于该项目");

  if (successors.some((s) => s.parentTaskId !== pred.parentTaskId))
    throw new AppError("后置任务须与当前任务同级");

  if (uniqueIds.length > 0) {
    // 间接环：沿反向边找出所有能到达前置的任务；待设后置若在其中，加边即环。
    const projectEdges = await db
      .select({
        predecessorId: taskDependencies.predecessorId,
        successorId: taskDependencies.successorId,
      })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.predecessorId, tasks.id))
      .where(eq(tasks.projectId, pred.projectId));

    const incoming = new Map<string, string[]>();
    for (const edge of projectEdges) {
      const list = incoming.get(edge.successorId) ?? [];
      list.push(edge.predecessorId);
      incoming.set(edge.successorId, list);
    }

    const ancestors = new Set<string>([predecessorId]);
    const stack = [predecessorId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const parent of incoming.get(current) ?? []) {
        if (ancestors.has(parent)) continue;
        ancestors.add(parent);
        stack.push(parent);
      }
    }

    if (uniqueIds.some((id) => ancestors.has(id)))
      throw new AppError("后置任务不可构成循环");
  }

  await db.transaction(async (tx) => {
    await tx.delete(taskDependencies).where(eq(taskDependencies.predecessorId, predecessorId));
    if (uniqueIds.length > 0) {
      await tx
        .insert(taskDependencies)
        .values(uniqueIds.map((sid) => ({ predecessorId, successorId: sid })));
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

// 依赖边上的一端（助手读任务详情 / 关系图用）
export type TaskLink = {
  id: string;
  title: string;
  status: TaskStatus;
  parentTaskId: string | null;
};

async function linkedTasks(direction: "up" | "down", taskId: string): Promise<TaskLink[]> {
  const selfCol = direction === "up" ? taskDependencies.successorId : taskDependencies.predecessorId;
  const otherCol = direction === "up" ? taskDependencies.predecessorId : taskDependencies.successorId;
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      parentTaskId: tasks.parentTaskId,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(otherCol, tasks.id))
    .where(eq(selfCol, taskId))
    .orderBy(tasks.sortOrder);
}

// 单任务的前置/后置（关系图的基本单元）。权限口径同 getTaskDetail。
export async function listTaskLinks(actorId: string, taskId: string) {
  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");
  await requireProjectAccess(actorId, task.projectId);

  const [predecessors, successors] = await Promise.all([
    linkedTasks("up", taskId),
    linkedTasks("down", taskId),
  ]);
  return { predecessors, successors };
}

// 项目级依赖边（带两端标题/状态/是否跨层级），供关系图与助手读工具用。
// 旧 listProjectDependencies 的返回形状被图页面与测试钉死，故另开一个函数。
export async function listProjectDependenciesDetailed(actorId: string, projectId: string) {
  await requireProjectAccess(actorId, projectId);

  const pred = alias(tasks, "pred");
  const succ = alias(tasks, "succ");
  const rows = await db
    .select({
      predecessorId: taskDependencies.predecessorId,
      predecessorTitle: pred.title,
      predecessorStatus: pred.status,
      predecessorParentTaskId: pred.parentTaskId,
      successorId: taskDependencies.successorId,
      successorTitle: succ.title,
      successorStatus: succ.status,
      successorParentTaskId: succ.parentTaskId,
    })
    .from(taskDependencies)
    // 权限过滤：边的前端须属于该项目（后端由插入时校验保证，这里只用作收敛）
    .innerJoin(tasks, eq(taskDependencies.predecessorId, tasks.id))
    .innerJoin(pred, eq(taskDependencies.predecessorId, pred.id))
    .innerJoin(succ, eq(taskDependencies.successorId, succ.id))
    .where(eq(tasks.projectId, projectId))
    .orderBy(pred.sortOrder, succ.sortOrder);

  return rows.map((r) => ({
    ...r,
    crossLevel: r.predecessorParentTaskId !== r.successorParentTaskId,
  }));
}

// 任务详情聚合：详情 + 子任务 + 前置/后置 + 里程碑/父任务标题。
// opts.projectId 用于项目 scope 的自校（防止项目助手读到别的项目）。
export async function getTaskDetailBundle(
  actorId: string,
  taskId: string,
  opts?: { projectId?: string },
) {
  const detail = await getTaskDetail(actorId, taskId);
  if (opts?.projectId && detail.projectId !== opts.projectId)
    throw new AppError("任务不属于该项目");

  const [subtasks, links, milestoneRow, parentRow] = await Promise.all([
    listSubtasks(actorId, taskId),
    listTaskLinks(actorId, taskId),
    detail.milestoneId
      ? db
          .select({ title: milestones.title })
          .from(milestones)
          .where(eq(milestones.id, detail.milestoneId))
      : Promise.resolve([]),
    detail.parentTaskId
      ? db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, detail.parentTaskId))
      : Promise.resolve([]),
  ]);

  return {
    ...detail,
    milestoneTitle: milestoneRow[0]?.title ?? null,
    parentTitle: parentRow[0]?.title ?? null,
    subtasks,
    predecessors: links.predecessors,
    successors: links.successors,
  };
}

// 后置任务的**增量**调整（add / remove），补 setTaskSuccessors 的全量替换语义。
// 只动「同级」边：历史跨层级边既不在可增范围、也不允许经此删除（显式报错，
// 否则 setTaskSuccessors 的 preserve 选项会让删除静默无效）。
export async function applyTaskSuccessorDelta(
  actorId: string,
  predecessorId: string,
  delta: { add?: string[] | null; remove?: string[] | null },
  opts?: { projectId?: string },
) {
  const add = [...new Set(delta.add ?? [])];
  const remove = [...new Set(delta.remove ?? [])];
  if (add.length === 0 && remove.length === 0)
    throw new AppError("没有要调整的后置任务");

  const [pred] = await db
    .select({ id: tasks.id, projectId: tasks.projectId, parentTaskId: tasks.parentTaskId })
    .from(tasks)
    .where(eq(tasks.id, predecessorId));
  if (!pred) throw new AppError("任务不存在");
  if (opts?.projectId && pred.projectId !== opts.projectId)
    throw new AppError("任务不属于该项目");
  await requireTaskWrite(actorId, pred.projectId);

  const rows = await db
    .select({
      successorId: taskDependencies.successorId,
      parentTaskId: tasks.parentTaskId,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.successorId, tasks.id))
    .where(eq(taskDependencies.predecessorId, predecessorId));

  const currentSiblingIds = rows
    .filter((r) => r.parentTaskId === pred.parentTaskId)
    .map((r) => r.successorId);
  const currentSiblingSet = new Set(currentSiblingIds);
  const allSuccessorSet = new Set(rows.map((r) => r.successorId));

  const crossLevelRemove = remove.filter(
    (id) => allSuccessorSet.has(id) && !currentSiblingSet.has(id),
  );
  if (crossLevelRemove.length)
    throw new AppError("跨层级后置任务不能通过此接口调整");

  // add / remove 有交集时 remove 优先：用户明确要删的边不应被同一次请求加回来。
  const actualRemove = remove.filter((id) => currentSiblingSet.has(id));
  const actualAdd = add.filter(
    (id) => !remove.includes(id) && !currentSiblingSet.has(id),
  );
  const next = [
    ...currentSiblingIds.filter((id) => !actualRemove.includes(id)),
    ...actualAdd,
  ];

  if (next.includes(predecessorId)) throw new AppError("后置任务不可构成循环");

  await setTaskSuccessors(actorId, predecessorId, next, {
    preserveCrossLevelIfSiblingSetUnchanged: true,
  });

  const { successors } = await listTaskLinks(actorId, predecessorId);
  return { predecessorId, added: actualAdd, removed: actualRemove, successors };
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
      startDate: tasks.startDate,
      dueDate: tasks.dueDate,
      requireApproval: tasks.requireApproval,
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
