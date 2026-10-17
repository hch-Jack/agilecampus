import { describe, expect, it } from "vitest";
import { resolveFlowScope } from "@/lib/flow-scope";
import type { FlowTask } from "@/lib/dependency-flow";

function task(id: string, patch: Partial<FlowTask> = {}): FlowTask {
  return {
    id,
    title: id,
    status: "todo",
    parentTaskId: null,
    sortOrder: 0,
    ...patch,
  };
}

const ids = (tasks: readonly { id: string }[]) => tasks.map((task) => task.id);

describe("resolveFlowScope · 层级切分", () => {
  it("顶层只包含 parentTaskId 为空的任务", () => {
    const scope = resolveFlowScope(
      [
        task("a", { sortOrder: 0 }),
        task("a1", { sortOrder: 1, parentTaskId: "a" }),
        task("b", { sortOrder: 2 }),
      ],
      null,
    );

    expect(scope).not.toBeNull();
    expect(ids(scope!.tasks)).toEqual(["a", "b"]);
    expect(scope!.parent).toBeNull();
    expect(scope!.ancestors).toEqual([]);
  });

  it("进入父任务后只返回直接子任务，不混入孙任务", () => {
    const scope = resolveFlowScope(
      [
        task("a", { sortOrder: 0 }),
        task("a1", { sortOrder: 1, parentTaskId: "a" }),
        task("a2", { sortOrder: 2, parentTaskId: "a" }),
        task("a1x", { sortOrder: 3, parentTaskId: "a1" }),
      ],
      "a",
    );

    expect(ids(scope!.tasks)).toEqual(["a1", "a2"]);
    expect(scope!.parent?.id).toBe("a");
    expect(ids(scope!.ancestors)).toEqual(["a"]);
  });

  it("面包屑包含从顶层到当前父任务的完整路径", () => {
    const scope = resolveFlowScope(
      [
        task("a", { sortOrder: 0 }),
        task("a1", { sortOrder: 1, parentTaskId: "a" }),
        task("a1x", { sortOrder: 2, parentTaskId: "a1" }),
        task("a1x1", { sortOrder: 3, parentTaskId: "a1x" }),
      ],
      "a1x",
    );

    expect(ids(scope!.ancestors)).toEqual(["a", "a1", "a1x"]);
    expect(ids(scope!.tasks)).toEqual(["a1x1"]);
  });

  it("叶子任务没有子流程，返回 null", () => {
    const scope = resolveFlowScope(
      [task("a", { sortOrder: 0 }), task("a1", { sortOrder: 1, parentTaskId: "a" })],
      "a1",
    );
    expect(scope).toBeNull();
  });

  it("不属于本项目的父任务返回 null", () => {
    const scope = resolveFlowScope([task("a")], "ghost");
    expect(scope).toBeNull();
  });

  it("父任务缺失时任务按顶层处理（孤儿不丢）", () => {
    const scope = resolveFlowScope(
      [task("a", { sortOrder: 0 }), task("x", { sortOrder: 1, parentTaskId: "ghost" })],
      null,
    );

    expect(ids(scope!.tasks)).toEqual(["a", "x"]);
  });

  it("重复 id 只保留首个，排序稳定", () => {
    const scope = resolveFlowScope(
      [
        task("b", { sortOrder: 1 }),
        task("a", { sortOrder: 0 }),
        task("a", { sortOrder: 5, title: "重复" }),
      ],
      null,
    );

    expect(ids(scope!.tasks)).toEqual(["a", "b"]);
    expect(scope!.tasks[0].title).toBe("a");
  });
});

describe("resolveFlowScope · 子任务统计与森林", () => {
  it("childStats 统计直属子任务总数与已完成数", () => {
    const scope = resolveFlowScope(
      [
        task("a", { sortOrder: 0 }),
        task("a1", { sortOrder: 1, parentTaskId: "a", status: "done" }),
        task("a2", { sortOrder: 2, parentTaskId: "a" }),
        task("a1x", { sortOrder: 3, parentTaskId: "a1" }),
        task("b", { sortOrder: 4 }),
      ],
      null,
    );

    expect(scope!.childStats).toEqual({
      a: { total: 2, done: 1 },
      a1: { total: 1, done: 0 },
    });
    expect(scope!.childStats.b).toBeUndefined();
  });

  it("森林按层级嵌套并保持 sortOrder", () => {
    const scope = resolveFlowScope(
      [
        task("b", { sortOrder: 2 }),
        task("a", { sortOrder: 0 }),
        task("a2", { sortOrder: 3, parentTaskId: "a" }),
        task("a1", { sortOrder: 1, parentTaskId: "a" }),
      ],
      null,
    );

    expect(scope!.roots.map((node) => node.task.id)).toEqual(["a", "b"]);
    expect(scope!.roots[0].children.map((node) => node.task.id)).toEqual([
      "a1",
      "a2",
    ]);
  });

  it("父链成环时不会死循环，相关任务按根处理", () => {
    const scope = resolveFlowScope(
      [
        task("a", { sortOrder: 0, parentTaskId: "b" }),
        task("b", { sortOrder: 1, parentTaskId: "a" }),
      ],
      null,
    );

    expect(scope).not.toBeNull();
    expect(ids(scope!.tasks).sort()).toEqual(["a", "b"]);
    expect(scope!.childStats).toEqual({});
  });
});
