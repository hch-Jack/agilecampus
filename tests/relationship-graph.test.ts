import { describe, expect, it } from "vitest";
import {
  MS_PER_DAY,
  parseDay,
} from "@/lib/gantt";
import {
  buildTaskForest,
  collectScheduledSpans,
  computeVisibleEdges,
  dependencyNeighbors,
  flattenChartRows,
  flattenUnscheduledRows,
  type GraphTask,
} from "@/lib/relationship-graph";

const SCHEDULED = { startDate: "2026-01-01", dueDate: "2026-01-02" };

function task(id: string, patch: Partial<GraphTask> = {}): GraphTask {
  return {
    id,
    title: id,
    status: "todo",
    startDate: null,
    dueDate: null,
    parentTaskId: null,
    sortOrder: 0,
    ...patch,
  };
}

const ids = (nodes: { task: GraphTask }[]) => nodes.map((n) => n.task.id);

describe("buildTaskForest", () => {
  it("空输入返回空森林", () => {
    expect(buildTaskForest([]).roots).toEqual([]);
  });

  it("按 sortOrder 排列根节点", () => {
    const forest = buildTaskForest([
      task("c", { sortOrder: 3 }),
      task("a", { sortOrder: 1 }),
      task("b", { sortOrder: 2 }),
    ]);
    expect(ids(forest.roots)).toEqual(["a", "b", "c"]);
  });

  it("sortOrder 相同时保持输入顺序", () => {
    const forest = buildTaskForest([task("b"), task("a")]);
    expect(ids(forest.roots)).toEqual(["b", "a"]);
  });

  it("保留任意深度的父子层级", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0 }),
      task("c", { sortOrder: 1, parentTaskId: "p" }),
      task("g", { sortOrder: 2, parentTaskId: "c" }),
    ]);
    expect(ids(forest.roots)).toEqual(["p"]);
    expect(ids(forest.roots[0].children)).toEqual(["c"]);
    expect(ids(forest.roots[0].children[0].children)).toEqual(["g"]);
  });

  it("父级不在项目任务列表中时提升为根", () => {
    const forest = buildTaskForest([task("a", { parentTaskId: "missing" })]);
    expect(ids(forest.roots)).toEqual(["a"]);
  });

  it("自引用父级提升为根且不成环", () => {
    const forest = buildTaskForest([task("a", { parentTaskId: "a" })]);
    expect(ids(forest.roots)).toEqual(["a"]);
    expect(forest.roots[0].children).toEqual([]);
  });

  it("两节点父子环收敛为一个根，且每个任务只出现一次", () => {
    const forest = buildTaskForest([
      task("a", { sortOrder: 0, parentTaskId: "b" }),
      task("b", { sortOrder: 1, parentTaskId: "a" }),
    ]);
    expect(ids(forest.roots)).toEqual(["a"]);
    expect(ids(forest.roots[0].children)).toEqual(["b"]);
    expect(forest.roots[0].children[0].children).toEqual([]);
    expect(forest.byId.size).toBe(2);
  });

  it("三节点父子环同样收敛", () => {
    const forest = buildTaskForest([
      task("a", { sortOrder: 0, parentTaskId: "b" }),
      task("b", { sortOrder: 1, parentTaskId: "c" }),
      task("c", { sortOrder: 2, parentTaskId: "a" }),
    ]);
    // a 的子级是 c（c.parentTaskId = a），回边 b → a 被丢弃
    expect(ids(forest.roots)).toEqual(["a"]);
    expect(ids(forest.roots[0].children)).toEqual(["c"]);
    expect(ids(forest.roots[0].children[0].children)).toEqual(["b"]);
    expect(forest.roots[0].children[0].children[0].children).toEqual([]);
  });

  it("正常树与独立环并存时都保留，并按 sortOrder 排列根", () => {
    const forest = buildTaskForest([
      task("a", { sortOrder: 0 }),
      task("b", { sortOrder: 1, parentTaskId: "c" }),
      task("c", { sortOrder: 2, parentTaskId: "b" }),
    ]);
    expect(ids(forest.roots)).toEqual(["a", "b"]);
    expect(ids(forest.roots[1].children)).toEqual(["c"]);
  });

  it("后代计数可穿过未排期中间节点", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("c", { sortOrder: 1, parentTaskId: "p" }),
      task("g", { sortOrder: 2, parentTaskId: "c", ...SCHEDULED }),
    ]);
    const p = forest.byId.get("p")!;
    const c = forest.byId.get("c")!;
    expect(p.descendantCount).toBe(2);
    expect(p.scheduledDescendantCount).toBe(1);
    expect(c.descendantCount).toBe(1);
    expect(c.scheduledDescendantCount).toBe(1);
  });
});

describe("collectScheduledSpans", () => {
  it("只收集已排期节点，含被折叠的子树", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("c", { sortOrder: 1, parentTaskId: "p", ...SCHEDULED }),
      task("u", { sortOrder: 2, parentTaskId: "p" }),
    ]);
    const spans = collectScheduledSpans(forest);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toEqual({
      start: parseDay("2026-01-01")!,
      end: parseDay("2026-01-03")!,
    });
  });
});

describe("flattenChartRows", () => {
  const today = parseDay("2026-01-10")!;

  it("默认展开，先序输出已排期行与深度", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("c", { sortOrder: 1, parentTaskId: "p", ...SCHEDULED }),
      task("g", { sortOrder: 2, parentTaskId: "c", ...SCHEDULED }),
    ]);
    const rows = flattenChartRows(forest, new Set(), today);
    expect(rows.map((r) => r.task.id)).toEqual(["p", "c", "g"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it("折叠父级隐藏整棵子树并报告隐藏的已排期后代数", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("c", { sortOrder: 1, parentTaskId: "p", ...SCHEDULED }),
      task("g", { sortOrder: 2, parentTaskId: "c", ...SCHEDULED }),
    ]);
    const rows = flattenChartRows(forest, new Set(["p"]), today);
    expect(rows.map((r) => r.task.id)).toEqual(["p"]);
    expect(rows[0].collapsed).toBe(true);
    expect(rows[0].hiddenScheduledCount).toBe(2);
    expect(rows[0].descendantCount).toBe(2);
  });

  it("没有已排期后代时折叠无效", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("c", { sortOrder: 1, parentTaskId: "p" }),
    ]);
    const rows = flattenChartRows(forest, new Set(["p"]), today);
    expect(rows).toHaveLength(1);
    expect(rows[0].collapsed).toBe(false);
    expect(rows[0].hasScheduledDescendants).toBe(false);
  });

  it("未排期父级不占行，已排期子级提升到深度 0", () => {
    const forest = buildTaskForest([
      task("u", { sortOrder: 0 }),
      task("s", { sortOrder: 1, parentTaskId: "u", ...SCHEDULED }),
    ]);
    const rows = flattenChartRows(forest, new Set(), today);
    expect(rows.map((r) => r.task.id)).toEqual(["s"]);
    expect(rows[0].depth).toBe(0);
  });

  it("已排期父 → 未排期中 → 已排期子：中间节点不占行且深度只加一", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("u", { sortOrder: 1, parentTaskId: "p" }),
      task("g", { sortOrder: 2, parentTaskId: "u", ...SCHEDULED }),
    ]);
    const rows = flattenChartRows(forest, new Set(), today);
    expect(rows.map((r) => r.task.id)).toEqual(["p", "g"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1]);
  });

  it("只输出已排期任务", () => {
    const forest = buildTaskForest([task("u"), task("s", { ...SCHEDULED })]);
    const rows = flattenChartRows(forest, new Set(), today);
    expect(rows.map((r) => r.task.id)).toEqual(["s"]);
  });

  it("计算逾期状态", () => {
    const forest = buildTaskForest([
      task("overdue", { startDate: "2026-01-01", dueDate: "2026-01-05" }),
      task("done", {
        startDate: "2026-01-01",
        dueDate: "2026-01-05",
        status: "done",
      }),
    ]);
    const rows = flattenChartRows(forest, new Set(), today);
    expect(rows.find((r) => r.task.id === "overdue")?.overdue).toBe(true);
    expect(rows.find((r) => r.task.id === "done")?.overdue).toBe(false);
  });
});

describe("flattenUnscheduledRows", () => {
  it("只输出未排期任务，深度只计未排期祖先", () => {
    const forest = buildTaskForest([
      task("p", { sortOrder: 0, ...SCHEDULED }),
      task("c", { sortOrder: 1, parentTaskId: "p" }),
      task("g", { sortOrder: 2, parentTaskId: "c" }),
      task("s", { sortOrder: 3, parentTaskId: "c", ...SCHEDULED }),
    ]);
    const rows = flattenUnscheduledRows(forest);
    expect(rows.map((r) => r.task.id)).toEqual(["c", "g"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1]);
  });

  it("未排期根与其已排期子级：只列出根", () => {
    const forest = buildTaskForest([
      task("u", { sortOrder: 0 }),
      task("s", { sortOrder: 1, parentTaskId: "u", ...SCHEDULED }),
    ]);
    expect(idsOf(flattenUnscheduledRows(forest))).toEqual(["u"]);
  });

  function idsOf(rows: { task: GraphTask }[]) {
    return rows.map((r) => r.task.id);
  }
});

describe("dependencyNeighbors", () => {
  const deps = [
    { predecessorId: "a", successorId: "b" },
    { predecessorId: "c", successorId: "a" },
    { predecessorId: "d", successorId: "e" },
  ];

  it("空 id 返回空集合", () => {
    expect(dependencyNeighbors(deps, null)).toEqual(new Set());
  });

  it("包含自身与直接前后置", () => {
    expect(dependencyNeighbors(deps, "a")).toEqual(new Set(["a", "b", "c"]));
  });

  it("无关任务只返回自身", () => {
    expect(dependencyNeighbors(deps, "z")).toEqual(new Set(["z"]));
  });

  it("忽略自环", () => {
    expect(
      dependencyNeighbors([{ predecessorId: "a", successorId: "a" }], "a"),
    ).toEqual(new Set(["a"]));
  });
});

describe("computeVisibleEdges", () => {
  const DAY = MS_PER_DAY;
  const min = parseDay("2026-01-01")!;
  const span = 100 * DAY;
  const chartWidth = 1000; // 1 天 = 10px

  function rowsOf(...tasks: GraphTask[]) {
    return flattenChartRows(buildTaskForest(tasks), new Set(), min);
  }

  const a = task("a", {
    sortOrder: 0,
    startDate: "2026-01-01",
    dueDate: "2026-01-11",
  });
  const b = task("b", {
    sortOrder: 1,
    startDate: "2026-01-20",
    dueDate: "2026-01-30",
  });

  it("为可见端点生成边，y 取行中心", () => {
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "b" }],
      rows: rowsOf(a, b),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(1);
    // a: 1/1→1/12（截止日 +1），右缘 110px；b: 1/20 起，左缘 190px
    expect(edges[0].x1).toBe(110);
    expect(edges[0].x2).toBe(188);
    expect(edges[0].y1).toBe(20);
    expect(edges[0].y2).toBe(60);
    expect(edges[0].path.startsWith("M 110 20 C")).toBe(true);
  });

  it("跳过自环", () => {
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "a" }],
      rows: rowsOf(a),
      min,
      span,
      chartWidth,
    });
    expect(edges).toEqual([]);
  });

  it("跳过未排期端点", () => {
    const u = task("u", { sortOrder: 1 });
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "u" }],
      rows: rowsOf(a, u),
      min,
      span,
      chartWidth,
    });
    expect(edges).toEqual([]);
  });

  it("跳过被折叠隐藏的端点", () => {
    const p = task("p", { sortOrder: 0, ...SCHEDULED });
    const child = task("child", {
      sortOrder: 1,
      parentTaskId: "p",
      ...SCHEDULED,
    });
    const rows = flattenChartRows(
      buildTaskForest([p, child]),
      new Set(["p"]),
      min,
    );
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "p", successorId: "child" }],
      rows,
      min,
      span,
      chartWidth,
    });
    expect(edges).toEqual([]);
  });

  it("宽度未测量时返回空数组", () => {
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "b" }],
      rows: rowsOf(a, b),
      min,
      span,
      chartWidth: 0,
    });
    expect(edges).toEqual([]);
  });

  it("后向依赖生成抬升曲线，端点仍然正确", () => {
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "b", successorId: "a" }],
      rows: rowsOf(a, b),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(1);
    // b: 1/20→1/31，右缘 300px；a: 1/1 起，左缘钳到 2px
    expect(edges[0].x1).toBe(300);
    expect(edges[0].x2).toBe(2);
    expect(edges[0].y1).toBe(60);
    expect(edges[0].y2).toBe(20);
    expect(edges[0].path.startsWith("M 300 60 C")).toBe(true);
  });

  it("多条后向依赖使用不同抬升车道", () => {
    const duplicate = [
      { predecessorId: "b", successorId: "a" },
      { predecessorId: "b", successorId: "a" },
    ];
    const edges = computeVisibleEdges({
      dependencies: duplicate,
      rows: rowsOf(a, b),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(2);
    expect(edges[0].path).not.toBe(edges[1].path);
  });

  it("跳过不在行集合中的端点", () => {
    const edges = computeVisibleEdges({
      dependencies: [
        { predecessorId: "a", successorId: "other-project" },
        { predecessorId: "ghost", successorId: "a" },
      ],
      rows: rowsOf(a),
      min,
      span,
      chartWidth,
    });
    expect(edges).toEqual([]);
  });
});
