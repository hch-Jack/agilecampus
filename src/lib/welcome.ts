import { addDays, todayIn, weekdayOfDate } from "./time";
import { listMyTasks } from "./task";
import { listMyTaskPlans, type TaskPlanSegment } from "./task-plan";
import { buildWorkbenchStats } from "./workbench-stats";

export type WelcomeStats = {
  overdue: number;
  dueToday: number;
  dueThisWeek: number;
  doing: number;
  plannedToday: number;
};

/**
 * 今日计划数：计划段是闭区间，一个任务当天可能有多段；按「任务」去重，
 * 与日程表格子里的 `plannedTasksOnDay` 口径一致。
 */
export function countPlannedTasksOnDay(
  plans: Record<string, TaskPlanSegment[]>,
  day: string,
): number {
  return Object.values(plans).filter((segments) =>
    segments.some((segment) => segment.start <= day && day <= segment.end),
  ).length;
}

/**
 * 欢迎页数据（只读）：四项任务统计 + 今日计划。
 *
 * 统计口径与工作台「任务统计」一致（我的任务 = 进行中项目里的顶层任务，
 * 按用户时区的日历串比较日期）；今日计划直接读日程表的个人排期。
 */
export async function getWelcomeStats(userId: string, tz: string): Promise<WelcomeStats> {
  const tasks = await listMyTasks(userId);
  const today = todayIn(tz);
  const weekEnd = addDays(today, (7 - weekdayOfDate(today)) % 7);
  const stats = buildWorkbenchStats(tasks, today, weekEnd);

  // 日程表的计划只覆盖我的任务，故这里用同一批 taskId 取计划段
  const plans = await listMyTaskPlans(
    userId,
    tasks.map((task) => task.id),
  );

  return {
    overdue: stats.overdue,
    dueToday: stats.today,
    dueThisWeek: stats.week,
    doing: stats.doing,
    plannedToday: countPlannedTasksOnDay(plans, today),
  };
}
