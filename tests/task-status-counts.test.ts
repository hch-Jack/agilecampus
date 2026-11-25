import { describe, expect, it } from "vitest";
import { countTaskStatuses } from "@/lib/task-status-counts";

const TASKS = [
  { id: "t1", status: "todo" as const },
  { id: "t2", status: "todo" as const },
  { id: "t3", status: "doing" as const },
  { id: "t4", status: "doing" as const },
  { id: "t5", status: "done" as const },
];

describe("countTaskStatuses", () => {
  it("按待办/进行中/已完成计数", () => {
    expect(countTaskStatuses(TASKS, new Set())).toEqual({
      todo: 2,
      doing: 2,
      pending: 0,
      done: 1,
    });
  });

  it("待审批优先于底层状态", () => {
    expect(countTaskStatuses(TASKS, new Set(["t3", "t5"]))).toEqual({
      todo: 2,
      doing: 1,
      pending: 2,
      done: 0,
    });
  });

  it("空列表全为 0", () => {
    expect(countTaskStatuses([], new Set(["x"]))).toEqual({
      todo: 0,
      doing: 0,
      pending: 0,
      done: 0,
    });
  });

  it("传入列表含子任务时一并统计", () => {
    const withSubtask = [...TASKS, { id: "sub1", status: "doing" as const }];
    expect(countTaskStatuses(withSubtask, new Set())).toEqual({
      todo: 2,
      doing: 3,
      pending: 0,
      done: 1,
    });
  });
});
