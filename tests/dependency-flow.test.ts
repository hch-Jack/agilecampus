import { describe, expect, it } from "vitest";
import {
  LAYER_GAP_X,
  NODE_GAP_Y,
  NODE_H,
  NODE_W,
  PADDING_BOTTOM,
  PADDING_TOP,
  PADDING_X,
  PHASE_BAND_PAD_BOTTOM,
  PHASE_BAND_PAD_X,
  PHASE_HEADER_GAP,
  PHASE_HEADER_H,
  TERMINAL_GAP_X,
  TERMINAL_H,
  TERMINAL_W,
  computeDependencyFlow,
  type FlowTask,
} from "@/lib/dependency-flow";

const NODE_X0 = PADDING_X + TERMINAL_W + TERMINAL_GAP_X;
const NODE_Y0 = PADDING_TOP + PHASE_HEADER_H + PHASE_HEADER_GAP;
const BAND_CONTENT_H = PHASE_HEADER_H + PHASE_HEADER_GAP + PHASE_BAND_PAD_BOTTOM;
import type { Dependency } from "@/lib/relationship-graph";

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

const dep = (predecessorId: string, successorId: string): Dependency => ({
  predecessorId,
  successorId,
});

const layerOf = (
  layout: ReturnType<typeof computeDependencyFlow>,
  id: string,
) => layout.nodes.find((node) => node.task.id === id)!.layer;

const nodeOf = (
  layout: ReturnType<typeof computeDependencyFlow>,
  id: string,
) => layout.nodes.find((node) => node.task.id === id)!;

describe("computeDependencyFlow · 基础布局", () => {
  it("空输入返回空布局", () => {
    const layout = computeDependencyFlow({ tasks: [], dependencies: [] });
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.isolatedTaskIds).toEqual([]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
    expect(layout.counts.tasks).toBe(0);
  });

  it("链式依赖按 0/1/2 分层，并给出精确画布尺寸", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b"), dep("b", "c")],
    });

    expect(layout.nodes.map((node) => [node.task.id, node.layer])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    // 首末各留开始/结束胶囊的位置
    expect(layout.width).toBe(
      PADDING_X * 2 +
        TERMINAL_W * 2 +
        TERMINAL_GAP_X * 2 +
        3 * NODE_W +
        2 * LAYER_GAP_X,
    );
    expect(layout.height).toBe(
      PADDING_TOP + BAND_CONTENT_H + NODE_H + PADDING_BOTTOM,
    );
  });

  it("单边端点与路径几何正确", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a"), task("b", { sortOrder: 1 })],
      dependencies: [dep("a", "b")],
    });

    expect(nodeOf(layout, "a")).toMatchObject({
      x: NODE_X0,
      y: NODE_Y0,
      centerX: NODE_X0 + NODE_W / 2,
      centerY: NODE_Y0 + NODE_H / 2,
    });
    expect(nodeOf(layout, "b")).toMatchObject({
      x: NODE_X0 + NODE_W + LAYER_GAP_X,
      y: NODE_Y0,
    });
    expect(layout.edges[0]).toMatchObject({
      x1: NODE_X0 + NODE_W,
      y1: NODE_Y0 + NODE_H / 2,
      x2: NODE_X0 + NODE_W + LAYER_GAP_X,
      y2: NODE_Y0 + NODE_H / 2,
    });
    expect(
      layout.edges[0].path.startsWith(
        `M ${NODE_X0 + NODE_W} ${NODE_Y0 + NODE_H / 2} C`,
      ),
    ).toBe(true);
  });

  it("菱形汇聚到第三层，层内顺序按 sortOrder", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
        task("d", { sortOrder: 3 }),
      ],
      dependencies: [
        dep("a", "b"),
        dep("a", "c"),
        dep("b", "d"),
        dep("c", "d"),
      ],
    });

    expect(layerOf(layout, "a")).toBe(0);
    expect(layerOf(layout, "b")).toBe(1);
    expect(layerOf(layout, "c")).toBe(1);
    expect(layerOf(layout, "d")).toBe(2);
    expect(nodeOf(layout, "b").order).toBe(0);
    expect(nodeOf(layout, "c").order).toBe(1);
    // 两行的列：阶段标题 + 上下留白 + 2 张卡片 + 1 个行距
    expect(layout.height).toBe(
      PADDING_TOP +
        BAND_CONTENT_H +
        2 * NODE_H +
        NODE_GAP_Y +
        PADDING_BOTTOM,
    );
  });

  it("重心排序把后置任务拉到其前置附近", () => {
    // layer 0: a(0), b(1)；d 初始排在 c 前，但 d 依赖 b、c 依赖 a
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("d", { sortOrder: 2 }),
        task("c", { sortOrder: 3 }),
      ],
      dependencies: [dep("b", "d"), dep("a", "c")],
    });

    expect(layerOf(layout, "c")).toBe(1);
    expect(layerOf(layout, "d")).toBe(1);
    expect(nodeOf(layout, "c").order).toBe(0);
    expect(nodeOf(layout, "d").order).toBe(1);
  });

  it("相同输入重复计算结果深相等", () => {
    const input = {
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b"), dep("a", "c")],
    };
    expect(computeDependencyFlow(input)).toEqual(computeDependencyFlow(input));
  });

  it("sortOrder 相同的任务在同层内保持输入顺序", () => {
    const layout = computeDependencyFlow({
      tasks: [task("b"), task("a"), task("c", { sortOrder: 1 })],
      dependencies: [dep("b", "c"), dep("a", "c")],
    });
    expect(
      layout.nodes
        .filter((node) => node.layer === 0)
        .map((node) => node.task.id),
    ).toEqual(["b", "a"]);
  });
});

describe("computeDependencyFlow · 脏数据", () => {
  it("丢弃自环并计入计数", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a")],
      dependencies: [dep("a", "a")],
    });
    expect(layout.counts.selfLoops).toBe(1);
    expect(layout.edges).toEqual([]);
    expect(layout.isolatedTaskIds).toEqual(["a"]);
  });

  it("丢弃端点缺失的边", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a")],
      dependencies: [dep("a", "ghost")],
    });
    expect(layout.counts.missingEndpoints).toBe(1);
    expect(layout.edges).toEqual([]);
    expect(layout.isolatedTaskIds).toEqual(["a"]);
  });

  it("重复边只保留一条", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a"), task("b", { sortOrder: 1 })],
      dependencies: [dep("a", "b"), dep("a", "b")],
    });
    expect(layout.counts.duplicates).toBe(1);
    expect(layout.edges).toHaveLength(1);
  });

  it("重复任务 id 只保留首个", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a"), task("a", { title: "重复" }), task("b", { sortOrder: 1 })],
      dependencies: [dep("a", "b")],
    });
    expect(layout.counts.tasks).toBe(2);
    expect(layout.nodes).toHaveLength(2);
    expect(nodeOf(layout, "a").task.title).toBe("a");
  });
});

describe("computeDependencyFlow · 循环依赖", () => {
  it("二元环保留一条回边，分层仍有效", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a", { sortOrder: 0 }), task("b", { sortOrder: 1 })],
      dependencies: [dep("a", "b"), dep("b", "a")],
    });

    expect(layout.counts.cyclic).toBe(1);
    expect(layerOf(layout, "a")).toBe(0);
    expect(layerOf(layout, "b")).toBe(1);

    const forward = layout.edges.find((edge) => !edge.cyclic)!;
    const cyclic = layout.edges.find((edge) => edge.cyclic)!;
    expect(forward.path).not.toBe(cyclic.path);
    expect(
      cyclic.path.startsWith(
        `M ${nodeOf(layout, "b").x} ${nodeOf(layout, "b").centerY} C`,
      ),
    ).toBe(true);
  });

  it("三元环每个任务出现一次且恰有一条回边", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b"), dep("b", "c"), dep("c", "a")],
    });

    expect(layout.nodes).toHaveLength(3);
    expect(new Set(layout.nodes.map((node) => node.task.id)).size).toBe(3);
    expect(layout.counts.cyclic).toBe(1);
    expect([layerOf(layout, "a"), layerOf(layout, "b"), layerOf(layout, "c")]).toEqual([
      0, 1, 2,
    ]);
  });
});

describe("computeDependencyFlow · 同类判定与孤立任务", () => {
  it("同一父任务下的兄弟不算跨层级", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("p", { sortOrder: 0 }),
        task("c1", { sortOrder: 1, parentTaskId: "p" }),
        task("c2", { sortOrder: 2, parentTaskId: "p" }),
      ],
      dependencies: [dep("c1", "c2")],
    });
    expect(layout.edges[0].crossLevel).toBe(false);
    expect(layout.counts.crossLevel).toBe(0);
  });

  it("顶层任务之间不算跨层级", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a", { sortOrder: 0 }), task("b", { sortOrder: 1 })],
      dependencies: [dep("a", "b")],
    });
    expect(layout.edges[0].crossLevel).toBe(false);
  });

  it("父→子、子→父、不同父同深度都算跨层级", () => {
    const parentChild = computeDependencyFlow({
      tasks: [
        task("p", { sortOrder: 0 }),
        task("c", { sortOrder: 1, parentTaskId: "p" }),
      ],
      dependencies: [dep("p", "c")],
    });
    expect(parentChild.edges[0].crossLevel).toBe(true);

    const childParent = computeDependencyFlow({
      tasks: [
        task("p", { sortOrder: 0 }),
        task("c", { sortOrder: 1, parentTaskId: "p" }),
      ],
      dependencies: [dep("c", "p")],
    });
    expect(childParent.edges[0].crossLevel).toBe(true);

    const crossBranch = computeDependencyFlow({
      tasks: [
        task("p1", { sortOrder: 0 }),
        task("p2", { sortOrder: 1 }),
        task("c1", { sortOrder: 2, parentTaskId: "p1" }),
        task("c2", { sortOrder: 3, parentTaskId: "p2" }),
      ],
      dependencies: [dep("c1", "c2")],
    });
    expect(crossBranch.edges[0].crossLevel).toBe(true);
  });

  it("无依赖任务单独返回且不进入画布", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("z", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b")],
    });

    expect(layout.nodes.map((node) => node.task.id)).toEqual(["a", "b"]);
    expect(layout.isolatedTaskIds).toEqual(["z"]);
    expect(layout.counts.isolated).toBe(1);
  });

  it("只有自环的任务视为孤立", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a"), task("b", { sortOrder: 1 })],
      dependencies: [dep("a", "a"), dep("b", "b")],
    });
    expect(layout.nodes).toEqual([]);
    expect(layout.isolatedTaskIds).toEqual(["a", "b"]);
    expect(layout.width).toBe(0);
    expect(layout.height).toBe(0);
  });

  it("互不相连的多条链都保留，源点同层", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
        task("d", { sortOrder: 3 }),
      ],
      dependencies: [dep("a", "b"), dep("c", "d")],
    });

    expect(layerOf(layout, "a")).toBe(0);
    expect(layerOf(layout, "c")).toBe(0);
    expect(layerOf(layout, "b")).toBe(1);
    expect(layerOf(layout, "d")).toBe(1);
  });

  it("计数聚合正确", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("t1", { sortOrder: 0 }),
        task("t2", { sortOrder: 1 }),
        task("p", { sortOrder: 2 }),
        task("c", { sortOrder: 3, parentTaskId: "p" }),
      ],
      dependencies: [
        dep("t1", "t2"),
        dep("p", "c"),
        dep("c", "c"),
        dep("t1", "t2"),
        dep("t1", "ghost"),
      ],
    });

    expect(layout.counts).toEqual({
      tasks: 4,
      dependencies: 5,
      edges: 2,
      crossLevel: 1,
      cyclic: 0,
      selfLoops: 1,
      duplicates: 1,
      missingEndpoints: 1,
      isolated: 0,
    });
  });
});

describe("computeDependencyFlow · 流程语义", () => {
  it("最长链作为主线并编号，主线上每条边都有标记", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b"), dep("b", "c")],
    });

    expect(layout.mainPathTaskIds).toEqual(["a", "b", "c"]);
    expect(nodeOf(layout, "a").step).toBe(1);
    expect(nodeOf(layout, "b").step).toBe(2);
    expect(nodeOf(layout, "c").step).toBe(3);
    expect(layout.edges.every((edge) => edge.mainPath)).toBe(true);
  });

  it("主线并列时取 rank 更小的链，支线不编号", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
        task("d", { sortOrder: 3 }),
      ],
      dependencies: [
        dep("a", "b"),
        dep("a", "c"),
        dep("b", "d"),
        dep("c", "d"),
      ],
    });

    expect(layout.mainPathTaskIds).toEqual(["a", "b", "d"]);
    expect(nodeOf(layout, "c").step).toBeNull();
    expect(
      layout.edges
        .filter((edge) => edge.mainPath)
        .map((edge) => `${edge.predecessorId}-${edge.successorId}`),
    ).toEqual(["a-b", "b-d"]);
  });

  it("按前置完成情况推导可开始 / 等待前置", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0, status: "done" }),
        task("c", { sortOrder: 1 }),
        task("b", { sortOrder: 2, status: "doing" }),
        task("d", { sortOrder: 3 }),
      ],
      dependencies: [dep("a", "c"), dep("b", "d")],
    });

    expect(nodeOf(layout, "a").flowState).toBe("done");
    expect(nodeOf(layout, "c").flowState).toBe("ready");
    expect(nodeOf(layout, "b").flowState).toBe("doing");
    expect(nodeOf(layout, "d").flowState).toBe("blocked");
    expect(nodeOf(layout, "d").blockedBy).toBe(1);
  });

  it("多个未完成前置时 blockedBy 统计全部", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0, status: "done" }),
        task("b", { sortOrder: 1, status: "doing" }),
        task("c", { sortOrder: 2 }),
        task("d", { sortOrder: 3 }),
      ],
      dependencies: [dep("a", "d"), dep("b", "d"), dep("c", "d")],
    });

    expect(nodeOf(layout, "d").flowState).toBe("blocked");
    expect(nodeOf(layout, "d").blockedBy).toBe(2);
  });

  it("阶段按层生成，第一个未完成的阶段标记为当前", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0, status: "done" }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b"), dep("b", "c")],
    });

    expect(layout.phases).toHaveLength(3);
    expect(layout.phases.map((phase) => phase.done)).toEqual([1, 0, 0]);
    expect(layout.phases.map((phase) => phase.current)).toEqual([
      false,
      true,
      false,
    ]);
    expect(layout.phases[0]).toMatchObject({
      x: NODE_X0 - PHASE_BAND_PAD_X,
      width: NODE_W + PHASE_BAND_PAD_X * 2,
      total: 1,
    });
    expect(layout.progress).toEqual({ done: 1, total: 3, currentLayer: 1 });
  });

  it("全部完成时没有当前阶段", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0, status: "done" }),
        task("b", { sortOrder: 1, status: "done" }),
      ],
      dependencies: [dep("a", "b")],
    });

    expect(layout.progress.currentLayer).toBeNull();
    expect(layout.phases.every((phase) => !phase.current)).toBe(true);
  });

  it("开始/结束锚点对齐主线首末任务，并各连一条边", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
      ],
      dependencies: [dep("a", "b"), dep("b", "c")],
    });

    expect(layout.start).toMatchObject({
      x: PADDING_X,
      y: nodeOf(layout, "a").centerY - TERMINAL_H / 2,
      width: TERMINAL_W,
      height: TERMINAL_H,
    });
    expect(layout.end).toMatchObject({
      x: nodeOf(layout, "c").x + NODE_W + TERMINAL_GAP_X,
      y: nodeOf(layout, "c").centerY - TERMINAL_H / 2,
    });
    expect(layout.terminalEdges.map((edge) => edge.from)).toEqual([
      "start",
      "end",
    ]);
  });

  it("多源时开始连向所有源点，非末列汇点不强行连到结束", () => {
    const layout = computeDependencyFlow({
      tasks: [
        task("a", { sortOrder: 0 }),
        task("b", { sortOrder: 1 }),
        task("c", { sortOrder: 2 }),
        task("d", { sortOrder: 3 }),
        task("x", { sortOrder: 4 }),
        task("y", { sortOrder: 5 }),
      ],
      dependencies: [
        dep("a", "b"),
        dep("a", "c"),
        dep("c", "d"),
        dep("x", "y"),
      ],
    });

    // 源点 a、x 都从开始出发；汇点 b、y 不在末列，只有 d 连向结束
    expect(layout.terminalEdges.map((edge) => edge.from)).toEqual([
      "start",
      "start",
      "end",
    ]);
  });

  it("无依赖时任务全部视为孤立，不产生画布与锚点", () => {
    const layout = computeDependencyFlow({
      tasks: [task("a", { sortOrder: 0 }), task("b", { sortOrder: 1 })],
      dependencies: [],
    });

    expect(layout.nodes).toEqual([]);
    expect(layout.mainPathTaskIds).toEqual([]);
    expect(layout.start).toBeNull();
    expect(layout.end).toBeNull();
    expect(layout.terminalEdges).toEqual([]);
  });
});
