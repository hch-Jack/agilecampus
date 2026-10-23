import { describe, it, expect } from "vitest";
import { buildWorkbenchStats } from "@/lib/workbench-stats";

/**
 * 统计口径必须和改造前的 buildTiles 完全一致：
 * 除「进行中」外都只看未完成任务；日期按用户时区的日历串比较。
 */
describe("buildWorkbenchStats", () => {
  it("逾期 / 今天 / 本周 / 进行中各算各的", () => {
    const stats = buildWorkbenchStats(
      [
        { status: "todo", dueDate: "2026-10-20" },
        { status: "doing", dueDate: "2026-10-23" },
        { status: "todo", dueDate: "2026-10-24" },
        { status: "doing", dueDate: "2026-10-24" },
        { status: "todo", dueDate: "2026-10-25" },
        { status: "todo", dueDate: "2026-10-26" },
        { status: "doing", dueDate: null },
      ],
      "2026-10-24",
      "2026-10-25",
    );
    expect(stats).toEqual({ overdue: 2, today: 2, week: 1, doing: 3 });
  });

  it("已完成任务不进入逾期 / 今天 / 本周，也不计入进行中", () => {
    const stats = buildWorkbenchStats(
      [
        { status: "done", dueDate: "2026-10-01" },
        { status: "done", dueDate: "2026-10-24" },
        { status: "done", dueDate: null },
      ],
      "2026-10-24",
      "2026-10-25",
    );
    expect(stats).toEqual({ overdue: 0, today: 0, week: 0, doing: 0 });
  });

  it("本周边界：含今天之后、含 weekEnd 当天，weekEnd 之后不算", () => {
    const stats = buildWorkbenchStats(
      [
        { status: "todo", dueDate: "2026-10-24" },
        { status: "todo", dueDate: "2026-10-25" },
        { status: "todo", dueDate: "2026-10-26" },
      ],
      "2026-10-24",
      "2026-10-25",
    );
    expect(stats.week).toBe(1);
  });

  it("没有截止日期的未完成任务不虚增任何统计", () => {
    const stats = buildWorkbenchStats(
      [
        { status: "todo", dueDate: null },
        { status: "doing", dueDate: null },
      ],
      "2026-10-24",
      "2026-10-25",
    );
    expect(stats).toEqual({ overdue: 0, today: 0, week: 0, doing: 1 });
  });
});
