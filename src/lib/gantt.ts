// 甘特/时间轴共用的纯日历算术。时间线页与关系图共用，保证两处刻度口径一致。

export const MS_PER_DAY = 86_400_000;

export type DaySpan = { start: number; end: number };

// "YYYY-MM-DD" → **UTC** 零点毫秒；无值/非法返回 null。
//
// 这里刻意锚在 UTC：date 列是日历日、没有时区含义，而甘特图只需要「第几天到第几天」
// 的差值。以前锚在宿主本地零点，整张图的坐标系就跟着容器的时区跑，
// 今日竖线也就落在了宿主时区的今天上 —— 与看板按用户时区算的「今天」对不上。
// 锚在 UTC 后，坐标系是纯粹的日历算术，今日竖线由传入的 todayMs 决定。
export function parseDay(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

// parseDay 的反函数：UTC 零点毫秒 → "YYYY-MM-DD"。坐标系锚在 UTC（见 parseDay 注释），
// 故这里也取 UTC 年月日，保证 date 列往返自洽，不受宿主时区影响。
export function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * 任务的时间跨度：起始日缺省时用截止日，截止日含当日故 +1 天。
 * 只有一个日期时画成一天；两端都无 → null（未排期）。
 * 截止早于起始这类历史脏数据兜底为一天，避免出现零宽/负宽横条。
 */
export function inferTaskSpan(
  startDate: string | null | undefined,
  dueDate: string | null | undefined,
): DaySpan | null {
  const s = parseDay(startDate);
  const d = parseDay(dueDate);
  if (s === null && d === null) return null;
  const start = s ?? d!;
  let end = (d ?? s!) + MS_PER_DAY;
  if (end <= start) end = start + MS_PER_DAY;
  return { start, end };
}

export function isTaskOverdue(
  dueDate: string | null | undefined,
  status: string,
  todayMs: number,
): boolean {
  if (status === "done") return false;
  const due = parseDay(dueDate);
  // 截止日含当日：今天到期不算逾期
  return due !== null && due < todayMs;
}

export type TimeScaleInput = {
  spans: readonly DaySpan[];
  milestoneTargetDates: readonly (string | null)[];
  projectStartDate: string | null;
  projectEndDate: string | null;
  todayMs: number;
  tickCount?: number;
  paddingRatio?: number;
};

export type TimeScale = {
  min: number;
  max: number;
  span: number;
  ticks: number[];
  pct: (ms: number) => number;
};

/**
 * 时间轴范围：涵盖全部已排期任务、里程碑目标日、项目起止与今日，两端各留余白。
 * 用 reduce 而非 Math.min(...arr)，避免任务很多时展开参数栈溢出。
 */
export function buildTimeScale(input: TimeScaleInput): TimeScale {
  const tickCount = Math.max(2, input.tickCount ?? 5);
  const paddingRatio = input.paddingRatio ?? 0.04;

  let min = input.todayMs;
  let max = input.todayMs + MS_PER_DAY;

  for (const span of input.spans) {
    if (span.start < min) min = span.start;
    if (span.end > max) max = span.end;
  }
  for (const raw of input.milestoneTargetDates) {
    const t = parseDay(raw);
    if (t === null) continue;
    if (t < min) min = t;
    if (t + MS_PER_DAY > max) max = t + MS_PER_DAY;
  }
  const projectStart = parseDay(input.projectStartDate);
  if (projectStart !== null && projectStart < min) min = projectStart;
  const projectEnd = parseDay(input.projectEndDate);
  if (projectEnd !== null && projectEnd + MS_PER_DAY > max) {
    max = projectEnd + MS_PER_DAY;
  }

  const rawSpan = Math.max(max - min, MS_PER_DAY);
  const pad = rawSpan * paddingRatio;
  min -= pad;
  max += pad;
  const span = max - min;

  const ticks = Array.from(
    { length: tickCount },
    (_, i) => min + (span * i) / (tickCount - 1),
  );

  return {
    min,
    max,
    span,
    ticks,
    pct: (ms: number) => ((ms - min) / span) * 100,
  };
}
