// 工作台四个统计数的口径。原来内联在 dashboard/page.tsx，抽出后便于单测，
// 也供「合并概览」与四张独立统计卡共用。

export type WorkbenchStatKey = "overdue" | "today" | "week" | "doing";

export type WorkbenchStats = Record<WorkbenchStatKey, number>;

export const WORKBENCH_STAT_META: Record<
  WorkbenchStatKey,
  { label: string; tone: string }
> = {
  overdue: { label: "逾期", tone: "text-high" },
  today: { label: "今天截止", tone: "text-medium" },
  week: { label: "本周截止", tone: "text-doing" },
  doing: { label: "进行中", tone: "text-doing" },
};

/**
 * 全部统计都基于全量任务（与「隐藏已完成」/项目筛选无关），且除「进行中」外都只看未完成任务。
 * `today` / `weekEnd` 都是用户时区下的 YYYY-MM-DD 日历串，比较用字符串即可。
 */
export function buildWorkbenchStats(
  tasks: { status: string; dueDate: string | null }[],
  today: string,
  weekEnd: string,
): WorkbenchStats {
  const open = tasks.filter((task) => task.status !== "done");
  return {
    overdue: open.filter((task) => task.dueDate !== null && task.dueDate < today).length,
    today: open.filter((task) => task.dueDate === today).length,
    week: open.filter(
      (task) => task.dueDate !== null && task.dueDate > today && task.dueDate <= weekEnd,
    ).length,
    doing: tasks.filter((task) => task.status === "doing").length,
  };
}
