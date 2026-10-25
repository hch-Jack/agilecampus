import { describe, it, expect } from "vitest";
import { buildWorkbenchStats } from "@/lib/workbench-stats";
import { isOverdueTask, sortBoardTasks } from "@/lib/workbench-order";

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

describe("sortBoardTasks", () => {
  const today = "2026-10-24";
  const task = (
    id: string,
    dueDate: string | null,
    status: "todo" | "doing" | "done" = "todo",
  ) => ({ id, dueDate, status });

  it("逾期卡片置顶，多个逾期按逾期最久到最少", () => {
    const list = [
      task("normal-1", "2026-10-28"),
      task("late-2", "2026-10-21"),
      task("no-due", null),
      task("late-1", "2026-10-05"),
      task("today", "2026-10-24"),
      task("late-3", "2026-10-23"),
    ];
    expect(sortBoardTasks(list, today).map((t) => t.id)).toEqual([
      "late-1",
      "late-2",
      "late-3",
      "normal-1",
      "no-due",
      "today",
    ]);
  });

  it("非逾期保持原有相对顺序（稳定），已完成不算逾期", () => {
    const list = [
      task("a", null),
      task("b", "2026-10-01", "done"),
      task("c", "2026-10-30"),
      task("d", "2026-10-02"),
    ];
    expect(sortBoardTasks(list, today).map((t) => t.id)).toEqual(["d", "a", "b", "c"]);
    expect(isOverdueTask(list[1], today)).toBe(false);
  });

  it("同一天的逾期任务保持服务端顺序", () => {
    const list = [task("x", "2026-10-20"), task("y", "2026-10-20"), task("z", "2026-10-20")];
    expect(sortBoardTasks(list, today).map((t) => t.id)).toEqual(["x", "y", "z"]);
  });
});
