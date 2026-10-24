import { describe, expect, it } from "vitest";
import {
  addMonth,
  calendarGrid,
  taskCoversDay,
  ymKey,
  ymOf,
  type YM,
} from "@/lib/calendar";
import { MS_PER_DAY, parseDay } from "@/lib/gantt";
import { weekdayOfDate } from "@/lib/time";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe("ymOf / ymKey", () => {
  it("YYYY-MM-DD → {year,month}，与 ymKey 互为往返", () => {
    expect(ymOf("2026-10-24")).toEqual({ year: 2026, month: 10 });
    expect(ymKey({ year: 2026, month: 10 })).toBe("2026-10");
    expect(ymKey(ymOf("2026-03-08"))).toBe("2026-03");
    expect(ymKey(ymOf("2026-12-31"))).toBe("2026-12");
  });
});

describe("addMonth", () => {
  it("同年内进退", () => {
    expect(addMonth({ year: 2026, month: 1 }, 1)).toEqual({ year: 2026, month: 2 });
    expect(addMonth({ year: 2026, month: 10 }, -5)).toEqual({ year: 2026, month: 5 });
  });

  it("跨年进退正确", () => {
    expect(addMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonth({ year: 2026, month: 3 }, -5)).toEqual({ year: 2025, month: 10 });
  });
});

describe("calendarGrid", () => {
  const cases: YM[] = [
    { year: 2026, month: 1 },
    { year: 2026, month: 2 }, // 平年 2 月
    { year: 2024, month: 2 }, // 闰年 2 月
    { year: 2026, month: 10 },
    { year: 2027, month: 6 },
  ];

  it.each(cases)("恒为 6 周（42 天）且首日为周一、第 7 天为周日", (ym) => {
    const g = calendarGrid(ym);
    expect(g).toHaveLength(42);
    expect(weekdayOfDate(g[0])).toBe(1); // 周一
    expect(weekdayOfDate(g[6])).toBe(0); // 周日
  });

  it("逐日连续递增一天（UTC 锚定，不受时区影响）", () => {
    const g = calendarGrid({ year: 2026, month: 10 });
    for (let i = 1; i < g.length; i++) {
      expect(parseDay(g[i])! - parseDay(g[i - 1])!).toBe(MS_PER_DAY);
    }
  });

  it("当月每一天都在网格里，且当月 1 号落在第一周内", () => {
    const ym = { year: 2026, month: 10 };
    const g = calendarGrid(ym);
    for (let d = 1; d <= 31; d++) {
      expect(g).toContain(`2026-10-${String(d).padStart(2, "0")}`);
    }
    const firstIdx = g.indexOf("2026-10-01");
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(firstIdx).toBeLessThan(7);
  });

  it("跨月衔接：网格首日≤当月1号、与当月1号相距不超过6天", () => {
    const ym = { year: 2026, month: 10 };
    const g = calendarGrid(ym);
    const first = parseDay(g[0])!;
    const firstOfMonth = utc(2026, 10, 1);
    expect(first).toBeLessThanOrEqual(firstOfMonth);
    expect(firstOfMonth - first).toBeLessThan(7 * MS_PER_DAY);
  });
});

describe("taskCoversDay", () => {
  it("两端齐备：闭区间 [起始日, 截止日]", () => {
    const t = { startDate: "2026-10-10", dueDate: "2026-10-14" };
    expect(taskCoversDay(t, "2026-10-09")).toBe(false);
    expect(taskCoversDay(t, "2026-10-10")).toBe(true);
    expect(taskCoversDay(t, "2026-10-12")).toBe(true);
    expect(taskCoversDay(t, "2026-10-14")).toBe(true);
    expect(taskCoversDay(t, "2026-10-15")).toBe(false);
  });

  it("只有起始日：落在那一天", () => {
    expect(taskCoversDay({ startDate: "2026-10-10", dueDate: null }, "2026-10-10")).toBe(true);
    expect(taskCoversDay({ startDate: "2026-10-10", dueDate: null }, "2026-10-11")).toBe(false);
  });

  it("只有截止日：落在那一天", () => {
    expect(taskCoversDay({ startDate: null, dueDate: "2026-10-10" }, "2026-10-10")).toBe(true);
    expect(taskCoversDay({ startDate: null, dueDate: "2026-10-10" }, "2026-10-09")).toBe(false);
  });

  it("两端皆无：不覆盖任何天（未排期不进日历）", () => {
    expect(taskCoversDay({ startDate: null, dueDate: null }, "2026-10-10")).toBe(false);
  });

  it("起止同一天：覆盖那一天", () => {
    expect(taskCoversDay({ startDate: "2026-10-10", dueDate: "2026-10-10" }, "2026-10-10")).toBe(true);
  });
});
