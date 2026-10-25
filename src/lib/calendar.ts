// 工作台日历的纯日历算术。与 gantt.ts 同样锚在 UTC（日历日无时区含义），
// 保证周一为一周起点的口径与工作台「本周截止」一致（周末落在周日）。

import { formatDay, MS_PER_DAY } from "./gantt";

export type YM = { year: number; month: number }; // month: 1-12

const pad2 = (n: number) => String(n).padStart(2, "0");

/** {year,month} → "YYYY-MM"（用来判断某天是否在当前查看月内） */
export const ymKey = (ym: YM) => `${ym.year}-${pad2(ym.month)}`;

/** "YYYY-MM-DD" → {year,month} */
export const ymOf = (dateStr: string): YM => {
  const [y, m] = dateStr.split("-").map(Number);
  return { year: y, month: m };
};

/** 月份加减，跨年正确进退 */
export function addMonth(ym: YM, n: number): YM {
  const idx = ym.year * 12 + (ym.month - 1) + n;
  return { year: Math.floor(idx / 12), month: (idx % 12) + 1 };
}

/**
 * 月历网格：从该月首日所在周的**周一**起，共 6 周（42 天），覆盖所有月布局。
 * 用 getUTCDay（0=周日）折成周一为 0 的偏移。
 */
export function calendarGrid(ym: YM): string[] {
  const firstMs = Date.UTC(ym.year, ym.month - 1, 1);
  const firstDow = new Date(firstMs).getUTCDay(); // 0=周日 .. 6=周六
  const offset = (firstDow + 6) % 7; // 周一为 0、周二为 1 … 周日为 6
  const startMs = firstMs - offset * MS_PER_DAY;
  return Array.from({ length: 42 }, (_, i) => formatDay(startMs + i * MS_PER_DAY));
}

/**
 * 任务是否覆盖某一天：两端齐备看 [起始日, 截止日] 闭区间；
 * 只有一端则落在那一天；两端都没有则不覆盖（未排期，不进日历）。
 * 字典序比较即可——ISO 日期字典序即时间序。
 */
export function taskCoversDay(
  t: { startDate: string | null; dueDate: string | null },
  day: string,
): boolean {
  const s = t.startDate;
  const d = t.dueDate;
  if (s && d) return s <= day && day <= d;
  if (s) return s === day;
  if (d) return d === day;
  return false;
}
