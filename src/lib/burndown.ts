/**
 * 项目燃尽图：由任务动态（task_activities）重放「剩余任务数 / 总规模」随天的变化。
 *
 * 数据口径（仅顶层任务，与看板列同口径，子任务不重复计数）：
 * - created 动态 → 总规模 +1（任务被删则动态级联删除，规模随之回落，历史轻微失真可接受）
 * - 状态 → 已完成 → 剩余 -1；已完成 → 待办/进行中（重开/撤回）→ 剩余 +1
 * - 终点锚定当前库内真实状态：动态缺失的存量项目（活动功能上线前的数据）
 *   由「末端校正值」平移整条曲线，保持今日读数与看板一致
 *
 * 理想线（阶梯）：按剩余任务各自的 dueDate 归零——截止日早的先下台阶，
 * 对齐团队真实排期而非人为线性；已逾期的任务视为「马上要做」（台阶挪到明天），
 * 没填 dueDate 的任务在 [今天, 截止日] 区间线性均摊（取小数）。
 *
 * 吞吐预测（computePace）：近 14 天净完成速率（done−reopened/天）外推烧完日，
 * 与截止日比较即「照当前节奏能否按期」。速率≤0 不外推。
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { taskActivities, tasks } from "@/db/schema";
import { getProjectForUser } from "./project";
import { dateIn, todayIn } from "./time";
import { ForbiddenError } from "./errors";
import { resolveUserTimeZone } from "./time-pref";

export type BurndownEventKind = "created" | "done" | "reopened";

/** day = 用户时区下的 YYYY-MM-DD */
export type BurndownEvent = { day: string; kind: BurndownEventKind };

export type BurndownPoint = { day: string; remaining: number; total: number };

/**
 * 理想线（阶梯序列）：今天起按剩余任务 dueDate 逐级归零；
 * value 可为小数（无 dueDate 任务线性均摊的部分）。
 */
export type BurndownIdeal = { day: string; value: number }[];

export type BurndownResult = { points: BurndownPoint[]; ideal: BurndownIdeal };

/** 吞吐预测：近期净完成速率与外推烧完日（速率≤0 或已无剩余时 forecastDay 为空） */
export type BurndownPace = { ratePerDay: number; forecastDay: string | null } | null;

/** 近 14 天吞吐窗口 */
const PACE_WINDOW_DAYS = 14;

const DAY_MS = 86_400_000;

// 窗口上限（天）：跨年的超长项目截到最近两年，避免 SVG 点数失控
const MAX_SPAN_DAYS = 730;

function toDayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
}

function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 重放事件得到逐日序列（points 按天稠密排列，图表直接按索引定位悬停）。
 * anchors 是当前库内真实的总规模/剩余数，用于末端校正。
 * remainingDues/noDueRemaining 描述**当前未完成**顶层任务的排期，驱动阶梯理想线。
 */
export function buildBurndownSeries(input: {
  events: BurndownEvent[];
  window: { start: string; end: string };
  anchors: { totalNow: number; remainingNow: number };
  deadline: string | null;
  /** 今天（窗口 end 即今天；理想线锚点） */
  todayDay?: string;
  /** 未完成且填了 dueDate 的任务的截止日列表 */
  remainingDues?: string[];
  /** 未完成且没填 dueDate 的任务数 */
  noDueRemaining?: number;
}): BurndownResult {
  const todayN = toDayNumber(input.todayDay ?? input.window.end);
  const dueNums = (input.remainingDues ?? []).map(toDayNumber);
  // 理想线视界：项目截止日与剩余任务最晚 dueDate 的较大者（有排期才画线）
  const horizonN = Math.max(
    input.deadline ? toDayNumber(input.deadline) : -Infinity,
    ...dueNums,
  );

  let startN = toDayNumber(input.window.start);
  const endN = Math.max(toDayNumber(input.window.end), startN, horizonN);
  // 截断超长窗口（保留含今天的右端）
  if (endN - startN + 1 > MAX_SPAN_DAYS) startN = endN - MAX_SPAN_DAYS + 1;

  const byDay = new Map<string, { created: number; done: number; reopened: number }>();
  for (const e of input.events) {
    const b = byDay.get(e.day) ?? { created: 0, done: 0, reopened: 0 };
    b[e.kind] += 1;
    byDay.set(e.day, b);
  }

  let total = 0;
  let remaining = 0; // = total - doneCount，直接维护
  const points: BurndownPoint[] = [];
  for (let n = startN; n <= endN; n++) {
    const day = fromDayNumber(n);
    const b = byDay.get(day);
    if (b) {
      total += b.created;
      remaining += b.created - b.done + b.reopened;
    }
    points.push({ day, remaining, total });
  }

  // 末端校正：动态缺失（存量项目/活动功能上线前）时 replay 终点 ≠ 库内现状，
  // 用差值平移整条曲线；clamp 保证不为负、剩余不超总规模
  const last = points[points.length - 1];
  const totalShift = input.anchors.totalNow - last.total;
  const remainingShift = input.anchors.remainingNow - last.remaining;
  for (const p of points) {
    p.total = Math.max(0, p.total + totalShift);
    p.remaining = Math.min(Math.max(0, p.remaining + remainingShift), p.total);
  }

  // —— 阶梯理想线（锚定今天）——
  // 有 dueDate 的任务：各自 dueDate 下台阶；已逾期的视为「马上要做」（台阶挪到明天）。
  // 没 dueDate 的任务：在 [今天, 视界] 线性均摊（小数）。视界≤今天（无前向空间）不画。
  const today = input.todayDay ?? input.window.end;
  const todayPoint = points.find((p) => p.day === today);
  const ideal: BurndownIdeal = [];
  if (todayPoint && todayPoint.remaining > 0 && horizonN > todayN && endN >= horizonN) {
    const steps = new Map<number, number>(); // dayN → 台阶数
    for (const d of dueNums) {
      const at = Math.max(d, todayN + 1); // 逾期任务挪到明天
      steps.set(at, (steps.get(at) ?? 0) + 1);
    }
    const noDue = input.noDueRemaining ?? 0;
    const horizon = horizonN - todayN;
    let stepped = 0; // 已下台阶的任务数（累计）
    let value = todayPoint.remaining;
    ideal.push({ day: fromDayNumber(todayN), value });
    for (let n = todayN + 1; n <= horizonN; n++) {
      stepped += steps.get(n) ?? 0;
      const ramp = horizon > 0 ? (noDue * (n - todayN)) / horizon : 0;
      const next = todayPoint.remaining - stepped - ramp;
      if (Math.abs(next - value) > 1e-9) {
        value = next;
        ideal.push({ day: fromDayNumber(n), value: Math.max(0, value) });
      }
    }
  }
  return { points, ideal };
}

/**
 * 吞吐预测：近 14 天净完成速率（done−reopened/天）。速率>0 且仍有剩余时
 * 外推 forecastDay（今天 + ceil(剩余/速率) 天）；否则 forecastDay 为空。
 */
export function computePace(
  events: BurndownEvent[],
  today: string,
  remainingNow: number,
): BurndownPace {
  if (remainingNow <= 0) return null;
  const todayN = toDayNumber(today);
  const fromN = todayN - (PACE_WINDOW_DAYS - 1);
  let net = 0;
  for (const e of events) {
    const n = toDayNumber(e.day);
    if (n < fromN || n > todayN) continue;
    if (e.kind === "done") net += 1;
    else if (e.kind === "reopened") net -= 1;
  }
  const rate = net / PACE_WINDOW_DAYS;
  if (rate <= 0) return { ratePerDay: 0, forecastDay: null };
  const days = Math.ceil(remainingNow / rate);
  return { ratePerDay: rate, forecastDay: fromDayNumber(todayN + days) };
}

/** 页面数据装载：取项目、顶层任务现状与相关动态，产出图表可直接消费的序列 */
export async function loadBurndown(
  actorId: string,
  projectId: string,
): Promise<
  | (BurndownResult & {
      todayDay: string;
      projectName: string;
      hasTasks: boolean;
      deadlineDay: string | null;
      pace: BurndownPace;
    })
  | null
> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  const { project } = access;

  const tz = await resolveUserTimeZone(actorId);
  const today = todayIn(tz);

  const [topTasks, activityRows] = await Promise.all([
    db
      .select({ status: tasks.status, dueDate: tasks.dueDate })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.parentTaskId))),
    db
      .select({
        type: taskActivities.type,
        field: taskActivities.field,
        oldValue: taskActivities.oldValue,
        newValue: taskActivities.newValue,
        at: taskActivities.createdAt,
      })
      .from(taskActivities)
      .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
      .where(
        and(
          eq(tasks.projectId, projectId),
          isNull(tasks.parentTaskId),
          or(
            eq(taskActivities.type, "created"),
            and(eq(taskActivities.type, "field"), eq(taskActivities.field, "状态")),
          ),
        ),
      )
      .orderBy(asc(taskActivities.createdAt)),
  ]);

  const events: BurndownEvent[] = [];
  for (const r of activityRows) {
    const day = dateIn(tz, r.at);
    if (r.type === "created") events.push({ day, kind: "created" });
    else if (r.newValue === "已完成") events.push({ day, kind: "done" });
    else if (r.oldValue === "已完成") events.push({ day, kind: "reopened" });
    // 待办 ↔ 进行中：不影响燃尽，忽略
  }

  const totalNow = topTasks.length;
  const remainingNow = topTasks.filter((t) => t.status !== "done").length;

  // 截止日：项目 endDate 优先，缺省用顶层任务里最晚的 dueDate
  const dueDates = topTasks
    .map((t) => t.dueDate)
    .filter((d): d is string => Boolean(d))
    .sort();
  const deadlineDay = project.endDate ?? dueDates.at(-1) ?? null;

  // 理想线的驱动数据：当前未完成任务的排期
  const remainingTop = topTasks.filter((t) => t.status !== "done");
  const remainingDues = remainingTop
    .map((t) => t.dueDate)
    .filter((d): d is string => Boolean(d));
  const noDueRemaining = remainingTop.length - remainingDues.length;

  // 窗口起点：最早的创建动态 / 项目起始日 / 今天 三者取最早（无任务则空态）
  const candidates = [events[0]?.day, project.startDate, today].filter(
    (d): d is string => Boolean(d),
  );
  const windowStart = candidates.sort()[0];

  const result = buildBurndownSeries({
    events,
    window: { start: windowStart, end: today },
    anchors: { totalNow, remainingNow },
    deadline: deadlineDay,
    todayDay: today,
    remainingDues,
    noDueRemaining,
  });
  const pace = computePace(events, today, remainingNow);

  return {
    ...result,
    todayDay: today,
    projectName: project.name,
    hasTasks: totalNow > 0,
    deadlineDay,
    pace,
  };
}
