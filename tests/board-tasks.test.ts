import { describe, it, expect } from "vitest";
import { splitBoardTasks } from "@/lib/board-tasks";

const task = (id: string, parentTaskId: string | null, status = "todo") => ({
  id,
  parentTaskId,
  status,
});

describe("splitBoardTasks", () => {
  it("只把顶层任务摆上看板，子任务按父聚合出完成数", () => {
    const { topLevel, progress } = splitBoardTasks([
      task("p1", null),
      task("p2", null, "done"),
      task("c1", "p1", "done"),
      task("c2", "p1"),
      task("c3", "p1"),
      task("c4", "p2", "done"),
    ]);

    expect(topLevel.map((t) => t.id)).toEqual(["p1", "p2"]);
    expect(progress.get("p1")).toEqual({ total: 3, done: 1 });
    expect(progress.get("p2")).toEqual({ total: 1, done: 1 });
    expect(progress.has("p3")).toBe(false);
  });

  it("孙任务只计入直接父任务，不会混进顶层任务", () => {
    const { topLevel, progress } = splitBoardTasks([
      task("p", null),
      task("c", "p", "done"),
      task("g", "c", "done"),
    ]);

    expect(topLevel.map((t) => t.id)).toEqual(["p"]);
    expect(progress.get("p")).toEqual({ total: 1, done: 1 });
    expect(progress.get("c")).toEqual({ total: 1, done: 1 });
  });

  it("没有子任务时不给进度；空列表也安全", () => {
    const { topLevel, progress } = splitBoardTasks([task("p", null)]);
    expect(topLevel).toHaveLength(1);
    expect(progress.size).toBe(0);

    expect(splitBoardTasks([])).toEqual({ topLevel: [], progress: new Map() });
  });
});
