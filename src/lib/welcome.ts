import { and, count, eq, isNotNull, lte, or } from "drizzle-orm";
import { db } from "@/db";
import { projects, tasks } from "@/db/schema";
import { addDays, todayIn } from "./time";

export type WelcomeStats = {
  doing: number;
  todo: number;
  risk: number;
  phaseDone: number;
  phaseTotal: number;
  totalDone: number;
  totalTotal: number;
};

function sumByStatus(rows: { status: string; n: number }[]) {
  const todo = Number(rows.find((r) => r.status === "todo")?.n ?? 0);
  const doing = Number(rows.find((r) => r.status === "doing")?.n ?? 0);
  const done = Number(rows.find((r) => r.status === "done")?.n ?? 0);
  return { todo, doing, done, total: todo + doing + done };
}

// 欢迎页数据（只读）：进行中 / 待办 / 临近逾期 + 两条进度。
// tz 由调用方解析后传入 —— 本模块不读 cookie，保持「给什么时区就按什么算」。
export async function getWelcomeStats(userId: string, tz: string): Promise<WelcomeStats> {
  // 我的全部任务，按状态聚合
  const mineRows = await db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .where(eq(tasks.assigneeId, userId))
    .groupBy(tasks.status);
  const mine = sumByStatus(mineRows);

  // 「本阶段」＝我参与的进行中(active)项目里的任务
  const phaseRows = await db
    .select({ status: tasks.status, n: count() })
    .from(tasks)
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(and(eq(tasks.assigneeId, userId), eq(projects.status, "active")))
    .groupBy(tasks.status);
  const phase = sumByStatus(phaseRows);

  // 临近逾期：未完成且截止日期在 3 天内（含已逾期）。
  // 边界走「用户的今天是哪一天 + 3」的纯日历运算 —— 原先是
  // `setDate` 加三天再 toISOString()，那等于拿 UTC 的今天往后推，
  // 北京时间晚上 8 点后整体偏一天。
  const warnStr = addDays(todayIn(tz), 3);
  const [riskRow] = await db
    .select({ n: count() })
    .from(tasks)
    .where(
      and(
        eq(tasks.assigneeId, userId),
        or(eq(tasks.status, "todo"), eq(tasks.status, "doing")),
        isNotNull(tasks.dueDate),
        lte(tasks.dueDate, warnStr),
      ),
    );

  return {
    doing: mine.doing,
    todo: mine.todo,
    risk: Number(riskRow?.n ?? 0),
    phaseDone: phase.done,
    phaseTotal: phase.total,
    totalDone: mine.done,
    totalTotal: mine.total,
  };
}

