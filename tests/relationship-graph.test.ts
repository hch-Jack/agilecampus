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
    // a: 1/1→1/12（截止日 +1），右缘 110px；x2 为箭头尖端贴的 b 横条左缘 190px
    expect(edges[0].x1).toBe(110);
    expect(edges[0].x2).toBe(190);
    expect(edges[0].y1).toBe(20);
    expect(edges[0].y2).toBe(60);
    // 单条出边保持行中心（扇出 0）；线停在箭头底边 182，三角形补完最后 8px 贴条
    expect(edges[0].path).toBe(
      "M 110 20 L 116 20 Q 122 20 122 26 L 122 54 Q 122 60 128 60 L 182 60",
    );
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

  it("后向依赖从后置横条右缘进入，竖距最短不绕行", () => {
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "b", successorId: "a" }],
      rows: rowsOf(a, b),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(1);
    // b: 1/20→1/31，右缘 300px；a: 1/1→1/12，右缘 110px。
    // 时间倒挂：竖段贴在 312，线停在箭头底边 118，尖端向左贴上 a 的右缘 110
    expect(edges[0].x1).toBe(300);
    expect(edges[0].x2).toBe(2);
    expect(edges[0].y1).toBe(60);
    expect(edges[0].y2).toBe(20);
    expect(edges[0].path).toBe(
      "M 300 60 L 306 60 Q 312 60 312 54 L 312 26 Q 312 20 306 20 L 118 20",
    );
  });

  it("重复的依赖沿锚点扇开，路径互不相同", () => {
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
    // 出/入锚点各沿横条高度 ±6 扇开，两条线不重叠
    expect(edges[0].path.startsWith("M 300 54 L")).toBe(true);
    expect(edges[1].path.startsWith("M 300 66 L")).toBe(true);
    expect(edges[0].path).not.toBe(edges[1].path);
  });

  it("同一前置的多条出边沿横条高度扇开锚点", () => {
    const c1 = task("c1", {
      sortOrder: 2,
      startDate: "2026-01-25",
      dueDate: "2026-02-05",
    });
    const edges = computeVisibleEdges({
      dependencies: [
        { predecessorId: "a", successorId: "b" },
        { predecessorId: "a", successorId: "c1" },
      ],
      rows: rowsOf(a, b, c1),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(2);
    // 后置行号小的锚点在上：a 行中心 20 ± 6
    expect(edges[0].path.startsWith("M 110 14 L")).toBe(true);
    expect(edges[1].path.startsWith("M 110 26 L")).toBe(true);
    expect(edges[0].path).not.toBe(edges[1].path);
  });

  it("同一后置的多条入边沿横条高度扇开锚点", () => {
    const c2 = task("c2", {
      sortOrder: 2,
      startDate: "2026-01-25",
      dueDate: "2026-02-05",
    });
    const edges = computeVisibleEdges({
      dependencies: [
        { predecessorId: "a", successorId: "c2" },
        { predecessorId: "b", successorId: "c2" },
      ],
      rows: rowsOf(a, b, c2),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(2);
    // 前置行号小的锚点在上：c2 行中心 100 ± 6；
    // b→c2 时间倒挂（c2 左缘 240 < b 右缘 312），线停在底边 368、尖端贴右缘 360
    expect(edges[0].path.endsWith("L 232 94")).toBe(true);
    expect(edges[1].path.endsWith("L 368 106")).toBe(true);
  });

  it("同一出发列的前向边共享车道，行中心与锚点使路径互异", () => {
    const d = task("d", {
      sortOrder: 1,
      startDate: "2026-01-06",
      dueDate: "2026-01-11",
    });
    const c3 = task("c3", {
      sortOrder: 2,
      startDate: "2026-01-25",
      dueDate: "2026-02-05",
    });
    const edges = computeVisibleEdges({
      dependencies: [
        { predecessorId: "a", successorId: "c3" },
        { predecessorId: "d", successorId: "c3" },
      ],
      rows: rowsOf(a, d, c3),
      min,
      span,
      chartWidth,
    });
    expect(edges).toHaveLength(2);
    // a 右缘 110、d 右缘 110 → 同一默认车道 122（d 行横条 [50,110] 不挡道），
    // 两行中心不同、入边锚点扇开，路径自然分开
    expect(edges[0].path.startsWith("M 110 20 L 116 20 Q 122 20 122 26")).toBe(
      true,
    );
    expect(edges[1].path.startsWith("M 110 60 L 116 60 Q 122 60 122 66")).toBe(
      true,
    );
    expect(edges[0].path).not.toBe(edges[1].path);
  });

  it("肘形线的转角数量：前向、后向各 2 个", () => {
    const forward = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "b" }],
      rows: rowsOf(a, b),
      min,
      span,
      chartWidth,
    });
    const e = task("e", {
      sortOrder: 0,
      startDate: "2026-01-01",
      dueDate: "2026-01-20",
    });
    const f = task("f", {
      sortOrder: 1,
      startDate: "2026-01-05",
      dueDate: "2026-01-08",
    });
    const backward = computeVisibleEdges({
      dependencies: [{ predecessorId: "e", successorId: "f" }],
      rows: rowsOf(e, f),
      min,
      span,
      chartWidth,
    });
    expect((forward[0].path.match(/Q/g) ?? []).length).toBe(2);
    expect((backward[0].path.match(/Q/g) ?? []).length).toBe(2);
  });

  it("紧前向间距收缩末段圆角", () => {
    const g = task("g", {
      sortOrder: 1,
      startDate: "2026-01-14",
      dueDate: "2026-01-20",
    });
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "g" }],
      rows: rowsOf(a, g),
      min,
      span,
      chartWidth,
    });
    // g 横条左缘 130、线停底边 122：间距不足，车道收到前置右缘外 2px（112），
    // 出横条 2px 短截被圆角吞掉（零长度 L 跳过），圆角后余 4px 直线到 122
    expect(edges[0].path).toBe(
      "M 110 20 Q 112 20 112 22 L 112 54 Q 112 60 118 60 L 122 60",
    );
  });

  it("紧间距下多条前向边共享车道，靠锚点扇开", () => {
    const h1 = task("h1", {
      sortOrder: 1,
      startDate: "2026-01-14",
      dueDate: "2026-01-18",
    });
    const h2 = task("h2", {
      sortOrder: 2,
      startDate: "2026-01-14",
      dueDate: "2026-01-18",
    });
    const edges = computeVisibleEdges({
      dependencies: [
        { predecessorId: "a", successorId: "h1" },
        { predecessorId: "a", successorId: "h2" },
      ],
      rows: rowsOf(a, h1, h2),
      min,
      span,
      chartWidth,
    });
    // 间距不足（线停底边 122），车道收到 112；出边锚点沿 a 横条高度 20 ± 6 扇开
    expect(edges[0].path).toBe(
      "M 110 14 Q 112 14 112 16 L 112 54 Q 112 60 118 60 L 122 60",
    );
    expect(edges[1].path).toBe(
      "M 110 26 Q 112 26 112 28 L 112 94 Q 112 100 118 100 L 122 100",
    );
  });

  it("竖向车道避让中间横条，从空档处通过", () => {
    const b2 = task("b2", {
      sortOrder: 1,
      startDate: "2026-01-13",
      dueDate: "2026-01-20",
    });
    const c = task("c", {
      sortOrder: 2,
      startDate: "2026-01-30",
      dueDate: "2026-02-09",
    });
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "c" }],
      rows: rowsOf(a, b2, c),
      min,
      span,
      chartWidth,
    });
    // b2 横条 [120,200] 挡住 122–200 的默认车道，搜索步进到 206 通过；
    // c 横条左缘 290，线停在底边 282
    expect(edges[0].path).toBe(
      "M 110 20 L 200 20 Q 206 20 206 26 L 206 94 Q 206 100 212 100 L 282 100",
    );
  });

  it("同目标的两条后向边共享车道，入边锚点沿横条高度扇开", () => {
    const d = task("d", {
      sortOrder: 1,
      startDate: "2026-01-06",
      dueDate: "2026-01-11",
    });
    const c = task("c", {
      sortOrder: 2,
      startDate: "2026-01-02",
      dueDate: "2026-01-04",
    });
    const edges = computeVisibleEdges({
      dependencies: [
        { predecessorId: "a", successorId: "c" },
        { predecessorId: "d", successorId: "c" },
      ],
      rows: rowsOf(a, d, c),
      min,
      span,
      chartWidth,
    });
    // 两前置右缘同为 110 → 共享车道 122（d 横条 [50,110] 不挡道）；
    // 都贴 c 横条 [10,40] 右缘 40（线停底边 48），入边锚点在 c 行中心 ± 6 扇开
    expect(edges[0].path).toBe(
      "M 110 20 L 116 20 Q 122 20 122 26 L 122 88 Q 122 94 116 94 L 48 94",
    );
    expect(edges[1].path).toBe(
      "M 110 60 L 116 60 Q 122 60 122 66 L 122 100 Q 122 106 116 106 L 48 106",
    );
  });

  it("后向边后置横条伸得更远时，车道仍守在箭头底边右侧、末段向左画", () => {
    // g2: 1/8→1/25，横条 [70,250] 比前置 a 的右缘 110 更靠右；
    // 若兜底车道落到底边 258 左侧，末段会向右画、箭头反向
    const g2 = task("g2", {
      sortOrder: 1,
      startDate: "2026-01-08",
      dueDate: "2026-01-25",
    });
    const edges = computeVisibleEdges({
      dependencies: [{ predecessorId: "a", successorId: "g2" }],
      rows: rowsOf(a, g2),
      min,
      span,
      chartWidth,
    });
    expect(edges[0].backward).toBe(true);
    // 车道在底边右侧 272（250 + 箭头 8 + 整直线 14），末段 272 → 258 向左，
    // 尖端向左贴上 g2 横条右缘 250
    expect(edges[0].path).toBe(
      "M 110 20 L 266 20 Q 272 20 272 26 L 272 54 Q 272 60 266 60 L 258 60",
    );
  });

  it("布局确定性：同输入两次调用一致，输入顺序决定输出顺序", () => {
    const c4 = task("c4", {
      sortOrder: 2,
      startDate: "2026-01-25",
      dueDate: "2026-02-05",
    });
    const deps = [
      { predecessorId: "a", successorId: "b" },
      { predecessorId: "a", successorId: "c4" },
      { predecessorId: "b", successorId: "a" },
    ];
    const shared = { rows: rowsOf(a, b, c4), min, span, chartWidth };
    expect(computeVisibleEdges({ dependencies: deps, ...shared })).toEqual(
      computeVisibleEdges({ dependencies: deps, ...shared }),
    );
    const reversed = computeVisibleEdges({
      dependencies: [...deps].reverse(),
      ...shared,
    });
    expect(
      reversed.map((edge) => `${edge.predecessorId}-${edge.successorId}`),
    ).toEqual(["b-a", "a-c4", "a-b"]);
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
