import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { tasks, taskPlans } from "@/db/schema";
import { AppError } from "./errors";
import { requireTaskWrite } from "./task";

// 个人计划的一段：闭区间 [start, end]，单天即起=止。一个任务可有多段。
export type TaskPlanSegment = { start: string; end: string };

/**
 * 取当前用户在给定任务集上的全部计划段（taskId → 段数组，按起始日升序）。
 * 日历据此把任务摆到覆盖的每一天；多段任务会在不连续的几段日子里都出现。
 */
export async function listMyTaskPlans(
  actorId: string,
  taskIds: string[],
): Promise<Record<string, TaskPlanSegment[]>> {
  if (taskIds.length === 0) return {};
  const rows = await db
    .select({
      taskId: taskPlans.taskId,
      start: taskPlans.plannedStart,
      end: taskPlans.plannedEnd,
    })
    .from(taskPlans)
    .where(and(eq(taskPlans.userId, actorId), inArray(taskPlans.taskId, taskIds)))
    .orderBy(taskPlans.plannedStart);
  const map: Record<string, TaskPlanSegment[]> = {};
  for (const r of rows) {
    (map[r.taskId] ??= []).push({ start: r.start, end: r.end });
  }
  return map;
}

/**
 * 校验并取任务：须属实且属该项目（防跨项目指 id）。返回无需值，仅做存在性与归属校验。
 * 权限沿用 requireTaskWrite（admin/student 可，teacher 只读）——个人计划虽不动任务本体，
 * 但沿同一道闸免得另开口径。
 */
async function requirePlanWrite(
  actorId: string,
  taskId: string,
  projectId: string,
): Promise<void> {
  await requireTaskWrite(actorId, projectId);
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)));
  if (!task) throw new AppError("任务不存在");
}

function normalizeRange(start: string, end: string): { start: string; end: string } {
  // 起晚于止：交换，令闭区间始终自洽（容忍用户从右往左框选，免得报错打断流程）
  return start <= end ? { start, end } : { start: end, end: start };
}

/** 增加一段计划。起>止会自动交换；同段重复由唯一索引去重（onConflictDoNothing）。 */
export async function addTaskPlanSegment(
  actorId: string,
  taskId: string,
  projectId: string,
  start: string,
  end: string,
) {
  await requirePlanWrite(actorId, taskId, projectId);
  const range = normalizeRange(start, end);
  await db
    .insert(taskPlans)
    .values({
      userId: actorId,
      taskId,
      plannedStart: range.start,
      plannedEnd: range.end,
    })
    .onConflictDoNothing({ target: [taskPlans.userId, taskPlans.taskId, taskPlans.plannedStart, taskPlans.plannedEnd] });
}

/** 删除指定那一段（起止须完全匹配）。 */
export async function removeTaskPlanSegment(
  actorId: string,
  taskId: string,
  projectId: string,
  start: string,
  end: string,
) {
  await requirePlanWrite(actorId, taskId, projectId);
  const range = normalizeRange(start, end);
  await db
    .delete(taskPlans)
    .where(
      and(
        eq(taskPlans.userId, actorId),
        eq(taskPlans.taskId, taskId),
        eq(taskPlans.plannedStart, range.start),
        eq(taskPlans.plannedEnd, range.end),
      ),
    );
}

/** 清空该任务的所有计划段。 */
export async function clearTaskPlan(
  actorId: string,
  taskId: string,
  projectId: string,
) {
  await requirePlanWrite(actorId, taskId, projectId);
  await db
    .delete(taskPlans)
    .where(and(eq(taskPlans.userId, actorId), eq(taskPlans.taskId, taskId)));
}
