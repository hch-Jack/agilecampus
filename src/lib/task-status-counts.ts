import type { TaskStatus } from "@/db/schema";

export type TaskStatusCounts = {
  todo: number;
  doing: number;
  pending: number;
  done: number;
};

/**
 * 看板四态的计数口径：待审批优先于底层状态。
 *
 * 「待审批」不落库，是由 pending 的 task_done 申请派生的列；任务自身状态仍是
 * todo/doing。这里与 `lib/board-columns` 的 `matches` 保持同一优先级，
 * 避免饼图的「待审批」与看板列数对不上。
 *
 * 统计范围由调用方传入的列表决定：项目页传全部任务（含子任务）。
 */
export function countTaskStatuses<T extends { id: string; status: TaskStatus }>(
  tasks: readonly T[],
  pendingApprovalIds: ReadonlySet<string>,
): TaskStatusCounts {
  const counts: TaskStatusCounts = { todo: 0, doing: 0, pending: 0, done: 0 };
  for (const task of tasks) {
    if (pendingApprovalIds.has(task.id)) {
      counts.pending += 1;
    } else {
      counts[task.status] += 1;
    }
  }
  return counts;
}
