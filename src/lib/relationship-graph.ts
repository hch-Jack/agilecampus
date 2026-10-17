// 关系图的纯布局逻辑：父子树、可见行、时间轴输入与依赖边几何。
// 不依赖 React / DOM，便于单元测试；客户端组件只负责折叠、hover 与宽度测量。

import { inferTaskSpan, isTaskOverdue, type DaySpan } from "./gantt";

export const ROW_HEIGHT = 40;
export const BAR_HEIGHT = 20;
export const BAR_MIN_WIDTH_PX = 20;

export type GraphTask = {
  id: string;
  title: string;
  status: string;
  startDate: string | null;
  dueDate: string | null;
  parentTaskId: string | null;
  sortOrder: number;
};

export type Dependency = { predecessorId: string; successorId: string };

export type GraphNode = {
  task: GraphTask;
  children: GraphNode[];
  span: DaySpan | null;
  scheduled: boolean;
  /** 全部后代数量（含未排期） */
  descendantCount: number;
  /** 已排期后代数量（可穿过未排期中间节点） */
  scheduledDescendantCount: number;
};

export type GraphForest = {
  roots: GraphNode[];
  byId: Map<string, GraphNode>;
};

export type ChartRow = {
  task: GraphTask;
  depth: number;
  span: DaySpan;
  overdue: boolean;
  hasScheduledDescendants: boolean;
  collapsed: boolean;
  hiddenScheduledCount: number;
  descendantCount: number;
  scheduledDescendantCount: number;
};

export type UnscheduledRow = {
  task: GraphTask;
  depth: number;
};

export type EdgeGeometry = Dependency & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path: string;
};

/**
 * 由扁平任务列表构建祖先森林。
 * - 子级按 sortOrder 排序（相同则保持输入顺序）
 * - parentTaskId 为空 / 指向不存在的任务 / 自引用 → 根
 * - 父子环（数据层未阻断）用 path + placed 丢弃回边，保证每个任务恰好出现一次
 */
export function buildTaskForest(tasks: readonly GraphTask[]): GraphForest {
  const sorted = tasks
    .map((task, inputIndex) => ({ task, inputIndex }))
    .sort(
      (a, b) =>
        a.task.sortOrder - b.task.sortOrder || a.inputIndex - b.inputIndex,
    );

  const byId = new Map<string, GraphNode>();
  const orderIndex = new Map<string, number>();
  sorted.forEach(({ task }, i) => {
    const span = inferTaskSpan(task.startDate, task.dueDate);
    byId.set(task.id, {
      task,
      children: [],
      span,
      scheduled: span !== null,
      descendantCount: 0,
      scheduledDescendantCount: 0,
    });
    orderIndex.set(task.id, i);
  });

  const roots: GraphNode[] = [];
  for (const { task } of sorted) {
    const node = byId.get(task.id)!;
    const parentId = task.parentTaskId;
    if (!parentId || parentId === task.id || !byId.has(parentId)) {
      roots.push(node);
    } else {
      byId.get(parentId)!.children.push(node);
    }
  }

  // DFS 丢弃回边；无根的分量（纯环）按顺序提升一个节点为根。
  const placed = new Set<string>();
  const orderedRoots: GraphNode[] = [];

  function visit(node: GraphNode, path: Set<string>) {
    if (placed.has(node.task.id)) return;
    placed.add(node.task.id);
    path.add(node.task.id);

    const kept: GraphNode[] = [];
    for (const child of node.children) {
      if (path.has(child.task.id) || placed.has(child.task.id)) continue;
      kept.push(child);
      visit(child, path);
    }
    node.children = kept;
    path.delete(node.task.id);
  }

  for (const root of roots) {
    if (placed.has(root.task.id)) continue;
    orderedRoots.push(root);
    visit(root, new Set());
  }

  for (const { task } of sorted) {
    if (placed.has(task.id)) continue;
    const node = byId.get(task.id)!;
    orderedRoots.push(node);
    visit(node, new Set());
  }

  orderedRoots.sort(
    (a, b) => (orderIndex.get(a.task.id) ?? 0) - (orderIndex.get(b.task.id) ?? 0),
  );

  function count(node: GraphNode): void {
    let all = 0;
    let scheduled = 0;
    for (const child of node.children) {
      count(child);
      all += 1 + child.descendantCount;
      scheduled += (child.scheduled ? 1 : 0) + child.scheduledDescendantCount;
    }
    node.descendantCount = all;
    node.scheduledDescendantCount = scheduled;
  }
  for (const root of orderedRoots) count(root);

  return { roots: orderedRoots, byId };
}

/** 全部已排期节点的跨度；折叠不应改变时间轴刻度，故与 collapsedIds 无关。 */
export function collectScheduledSpans(forest: GraphForest): DaySpan[] {
  const spans: DaySpan[] = [];
  function visit(node: GraphNode) {
    if (node.span) spans.push(node.span);
    for (const child of node.children) visit(child);
  }
  for (const root of forest.roots) visit(root);
  return spans;
}

/**
 * 先序展开已排期行。未排期的中间节点不占行，其已排期后代提升到同一 depth，
 * 以免层级因缺日期而断裂。
 */
export function flattenChartRows(
  forest: GraphForest,
  collapsedIds: ReadonlySet<string>,
  todayMs: number,
): ChartRow[] {
  const rows: ChartRow[] = [];

  function visit(node: GraphNode, depth: number) {
    let childDepth = depth;

    if (node.span) {
      const collapsed =
        collapsedIds.has(node.task.id) && node.scheduledDescendantCount > 0;

      rows.push({
        task: node.task,
        depth,
        span: node.span,
        overdue: isTaskOverdue(node.task.dueDate, node.task.status, todayMs),
        hasScheduledDescendants: node.scheduledDescendantCount > 0,
        collapsed,
        hiddenScheduledCount: collapsed ? node.scheduledDescendantCount : 0,
        descendantCount: node.descendantCount,
        scheduledDescendantCount: node.scheduledDescendantCount,
      });

      if (collapsed) return;
      childDepth = depth + 1;
    }

    for (const child of node.children) visit(child, childDepth);
  }

  for (const root of forest.roots) visit(root, 0);
  return rows;
}

/** 未排期清单：只输出未排期节点，depth 只计未排期祖先。 */
export function flattenUnscheduledRows(forest: GraphForest): UnscheduledRow[] {
  const rows: UnscheduledRow[] = [];

  function visit(node: GraphNode, depth: number) {
    let childDepth = depth;
    if (!node.span) {
      rows.push({ task: node.task, depth });
      childDepth = depth + 1;
    }
    for (const child of node.children) visit(child, childDepth);
  }

  for (const root of forest.roots) visit(root, 0);
  return rows;
}

/** 自身 + 直接前置/后置任务。taskId 为空时返回空集合。 */
export function dependencyNeighbors(
  dependencies: readonly Dependency[],
  taskId: string | null,
): Set<string> {
  const ids = new Set<string>();
  if (!taskId) return ids;
  ids.add(taskId);
  for (const d of dependencies) {
    if (d.predecessorId === d.successorId) continue;
    if (d.predecessorId === taskId) ids.add(d.successorId);
    if (d.successorId === taskId) ids.add(d.predecessorId);
  }
  return ids;
}

function edgePath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  chartHeight: number,
  backwardLane: number,
): string {
  const gap = 12;

  // 后置任务在时间上更晚：前置横条右缘 → 后置横条左缘的平滑曲线
  if (x2 >= x1 + gap) {
    const dx = Math.max(18, (x2 - x1) * 0.35);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  // 后置任务反而更早（允许的历史数据/长环）：把曲线抬到行间，避免穿过横条
  const dir = y1 <= y2 ? -1 : 1;
  const lift = 14 + (backwardLane % 4) * 6;
  const clampY = (y: number) => Math.max(4, Math.min(chartHeight - 4, y));
  const cy1 = clampY(y1 + dir * lift);
  const cy2 = clampY(y2 + dir * lift);
  return `M ${x1} ${y1} C ${x1 + 18} ${cy1}, ${x2 - 18} ${cy2}, ${x2} ${y2}`;
}

/**
 * 只为「当前可见且已排期」的端点生成依赖边。
 * 未排期、被折叠隐藏、跨项目/不存在的端点与自环一律跳过。
 */
export function computeVisibleEdges(args: {
  dependencies: readonly Dependency[];
  rows: readonly ChartRow[];
  min: number;
  span: number;
  chartWidth: number;
  rowHeight?: number;
  barMinWidthPx?: number;
}): EdgeGeometry[] {
  const {
    dependencies,
    rows,
    min,
    span,
    chartWidth,
    rowHeight = ROW_HEIGHT,
    barMinWidthPx = BAR_MIN_WIDTH_PX,
  } = args;

  if (chartWidth <= 0 || rows.length === 0 || span <= 0) return [];

  const rowIndex = new Map(rows.map((row, index) => [row.task.id, index]));
  const chartHeight = rows.length * rowHeight;
  const pct = (ms: number) => ((ms - min) / span) * 100;
  const clamp = (value: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, value));

  const edges: EdgeGeometry[] = [];
  let backwardLane = 0;

  for (const dep of dependencies) {
    if (dep.predecessorId === dep.successorId) continue;

    const pi = rowIndex.get(dep.predecessorId);
    const si = rowIndex.get(dep.successorId);
    if (pi === undefined || si === undefined) continue;

    const predecessor = rows[pi];
    const successor = rows[si];

    const pLeft = (pct(predecessor.span.start) / 100) * chartWidth;
    const pWidth = Math.max(
      ((pct(predecessor.span.end) - pct(predecessor.span.start)) / 100) *
        chartWidth,
      barMinWidthPx,
    );
    const x1 = clamp(pLeft + pWidth, 2, chartWidth - 2);
    const x2 = clamp((pct(successor.span.start) / 100) * chartWidth - 2, 2, chartWidth - 2);

    const y1 = pi * rowHeight + rowHeight / 2;
    const y2 = si * rowHeight + rowHeight / 2;
    const backward = x2 < x1 + 12;

    edges.push({
      ...dep,
      x1,
      y1,
      x2,
      y2,
      path: edgePath(
        x1,
        y1,
        x2,
        y2,
        chartHeight,
        backward ? backwardLane++ : 0,
      ),
    });
  }

  return edges;
}
