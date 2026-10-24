// 看板列的卡片排序：逾期优先，其余保持服务端顺序。纯函数，便于单测。

export type BoardTaskLike = {
  status: string;
  dueDate: string | null;
};

/**
 * 逾期 = 未完成且截止日早于用户时区的今天。
 * 已完成任务即使截止日已过也不算逾期 —— 它不再需要提醒。
 */
export function isOverdueTask(task: BoardTaskLike, today: string): boolean {
  return task.status !== "done" && task.dueDate !== null && task.dueDate < today;
}

/**
 * 逾期卡片置顶，多个逾期按截止日**从早到晚**（逾期最久的最上）；
 * 非逾期保持原有相对顺序（稳定排序），避免每次轮询都轻微换位。
 */
export function sortBoardTasks<T extends BoardTaskLike>(tasks: readonly T[], today: string): T[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const aOverdue = isOverdueTask(a.task, today);
      const bOverdue = isOverdueTask(b.task, today);
      if (aOverdue !== bOverdue) return aOverdue ? -1 : 1;
      if (!aOverdue) return a.index - b.index;
      const aDue = a.task.dueDate ?? "";
      const bDue = b.task.dueDate ?? "";
      if (aDue !== bDue) return aDue < bDue ? -1 : 1;
      return a.index - b.index;
    })
    .map((entry) => entry.task);
}
