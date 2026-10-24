import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  buildTimeScale,
  formatDay,
  formatMonthDay,
  inferTaskSpan,
  isTaskOverdue,
  parseDay,
} from "@/lib/gantt";

const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

describe("parseDay", () => {
  it("把 YYYY-MM-DD 解析为 UTC 零点", () => {
    expect(parseDay("2026-03-08")).toBe(utc(2026, 3, 8));
  });

  it("空值与非法日期返回 null", () => {
    expect(parseDay(null)).toBeNull();
    expect(parseDay(undefined)).toBeNull();
    expect(parseDay("")).toBeNull();
    expect(parseDay("not-a-date")).toBeNull();
    expect(parseDay("2026-13-01")).toBeNull();
  });

  it("不受宿主时区影响（UTC 锚定）", () => {
    expect(parseDay("2026-03-08")).toBe(Date.UTC(2026, 2, 8));
  });
});

describe("formatMonthDay", () => {
  it("输出 M/DD", () => {
    expect(formatMonthDay(utc(2026, 1, 5))).toBe("1/05");
    expect(formatMonthDay(utc(2026, 12, 31))).toBe("12/31");
  });
});

describe("inferTaskSpan", () => {
  it("起止都有：截止日含当日，跨度到次日零点", () => {
    expect(inferTaskSpan("2026-03-01", "2026-03-05")).toEqual({
      start: utc(2026, 3, 1),
      end: utc(2026, 3, 6),
    });
  });

  it("只有起始日：画成一天", () => {
    expect(inferTaskSpan("2026-03-01", null)).toEqual({
      start: utc(2026, 3, 1),
      end: utc(2026, 3, 2),
    });
  });

  it("只有截止日：从截止日画一天", () => {
    expect(inferTaskSpan(null, "2026-03-05")).toEqual({
      start: utc(2026, 3, 5),
      end: utc(2026, 3, 6),
    });
  });

  it("都没有返回 null", () => {
    expect(inferTaskSpan(null, null)).toBeNull();
  });

  it("截止早于起始的脏数据兜底为一天", () => {
    expect(inferTaskSpan("2026-03-10", "2026-03-08")).toEqual({
      start: utc(2026, 3, 10),
      end: utc(2026, 3, 11),
    });
  });

  it("非法日期按缺失处理", () => {
    expect(inferTaskSpan("bad", "2026-03-05")).toEqual({
      start: utc(2026, 3, 5),
      end: utc(2026, 3, 6),
    });
  });
});

describe("isTaskOverdue", () => {
  const today = utc(2026, 5, 10);

  it("逾期且未完成 → true", () => {
    expect(isTaskOverdue("2026-05-09", "todo", today)).toBe(true);
    expect(isTaskOverdue("2026-05-09", "doing", today)).toBe(true);
  });

  it("已完成不算逾期", () => {
    expect(isTaskOverdue("2026-05-09", "done", today)).toBe(false);
  });

  it("今天到期不算逾期（截止日含当日）", () => {
    expect(isTaskOverdue("2026-05-10", "todo", today)).toBe(false);
  });

  it("无截止日不算逾期", () => {
    expect(isTaskOverdue(null, "todo", today)).toBe(false);
  });
});

describe("buildTimeScale", () => {
  const today = utc(2026, 6, 15);

  it("空输入仍给出围绕今日的正跨度", () => {
    const scale = buildTimeScale({
      spans: [],
      milestoneTargetDates: [],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
    });
    expect(scale.span).toBeGreaterThan(0);
    expect(scale.pct(today)).toBeGreaterThanOrEqual(0);
    expect(scale.pct(today)).toBeLessThanOrEqual(100);
  });

  it("覆盖全部任务跨度", () => {
    const a = { start: utc(2026, 6, 1), end: utc(2026, 6, 5) };
    const b = { start: utc(2026, 6, 20), end: utc(2026, 7, 10) };
    const scale = buildTimeScale({
      spans: [a, b],
      milestoneTargetDates: [],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
    });
    expect(scale.min).toBeLessThan(a.start);
    expect(scale.max).toBeGreaterThan(b.end);
  });

  it("里程碑目标日即使远离任务也纳入范围", () => {
    const scale = buildTimeScale({
      spans: [{ start: utc(2026, 6, 1), end: utc(2026, 6, 2) }],
      milestoneTargetDates: ["2026-09-01"],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
    });
    const ms = utc(2026, 9, 1);
    expect(scale.min).toBeLessThan(ms);
    expect(scale.max).toBeGreaterThan(ms);
  });

  it("项目起止纳入范围，非法日期忽略", () => {
    const scale = buildTimeScale({
      spans: [],
      milestoneTargetDates: ["bad-date"],
      projectStartDate: "2026-01-10",
      projectEndDate: "2026-12-20",
      todayMs: today,
    });
    expect(scale.min).toBeLessThan(utc(2026, 1, 10));
    expect(scale.max).toBeGreaterThan(utc(2026, 12, 20));
  });

  it("两端留出约 4% 余白", () => {
    const a = { start: utc(2026, 6, 1), end: utc(2026, 6, 10) };
    const scale = buildTimeScale({
      spans: [a],
      milestoneTargetDates: [],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
    });
    expect(scale.pct(a.start)).toBeGreaterThan(0);
    expect(scale.pct(a.end)).toBeLessThan(100);
    // 余白约占整段的 4%
    expect(scale.pct(a.start)).toBeLessThan(8);
  });

  it("默认 5 个刻度，首尾等于 min/max", () => {
    const scale = buildTimeScale({
      spans: [],
      milestoneTargetDates: [],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
    });
    expect(scale.ticks).toHaveLength(5);
    expect(scale.ticks[0]).toBeCloseTo(scale.min, 5);
    expect(scale.ticks[4]).toBeCloseTo(scale.max, 5);
  });

  it("支持自定义刻度数与内边距", () => {
    const scale = buildTimeScale({
      spans: [],
      milestoneTargetDates: [],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
      tickCount: 3,
      paddingRatio: 0,
    });
    expect(scale.ticks).toHaveLength(3);
    expect(scale.pct(today)).toBeCloseTo(0, 5);
  });

  it("跨度至少一天", () => {
    const scale = buildTimeScale({
      spans: [],
      milestoneTargetDates: [],
      projectStartDate: null,
      projectEndDate: null,
      todayMs: today,
      paddingRatio: 0,
    });
    expect(scale.span).toBeGreaterThanOrEqual(MS_PER_DAY);
  });
});

describe("formatDay", () => {
  it("是 parseDay 的反函数（UTC 锚定）", () => {
    expect(formatDay(utc(2026, 3, 8))).toBe("2026-03-08");
    expect(formatDay(parseDay("2026-03-08")!)).toBe("2026-03-08");
  });

  it("跨月、跨年、补零", () => {
    expect(formatDay(utc(2026, 1, 5))).toBe("2026-01-05");
    expect(formatDay(utc(2026, 12, 31))).toBe("2026-12-31");
    expect(formatDay(utc(2027, 1, 1))).toBe("2027-01-01");
  });
});

