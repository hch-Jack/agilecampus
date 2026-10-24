/**
 * 项目看板的卡片来源：只显示顶层任务，子任务不单独占一张卡，
 * 而是按父任务聚合出「已完成 / 总数」，由父卡片底部的进度条体现。
 *
 * 口径与工作台的 listMySubtaskProgress 一致：只算直接子级，不递归；
 * 子任务的进度计入它自己的父任务，孙任务不会混进顶层任务。
 */
export type SubtaskProgress = { total: number; done: number };

export function splitBoardTasks<
  T extends { parentTaskId: string | null; status: string },
>(tasks: readonly T[]): { topLevel: T[]; progress: Map<string, SubtaskProgress> } {
  const topLevel: T[] = [];
  const progress = new Map<string, SubtaskProgress>();

  for (const task of tasks) {
    if (!task.parentTaskId) {
      topLevel.push(task);
      continue;
    }
    const parentId = task.parentTaskId;
    const row = progress.get(parentId) ?? { total: 0, done: 0 };
    row.total += 1;
    if (task.status === "done") row.done += 1;
    progress.set(parentId, row);
  }

  return { topLevel, progress };
}
