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
  /** 时间倒挂边：从后置横条右缘进入，箭头朝左（marker 据此选固定朝向） */
  backward: boolean;
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

// —— 依赖线：正交肘形路由（横 → 竖 → 横，转角收圆）——
// 竖段在各行的横条区间里做避让搜索，不穿过中间横条；
// 前向从后置左缘进入（箭头向右），后向（时间倒挂）从后置右缘进入（箭头向左），
// 竖距就是两行之间的最短距离，不绕目标行、不套圈；
// 线停在箭头底边，最后 ARROW_LEN 由三角形补完、尖端贴横条边缘；
// 箭头朝向按前向/后向在 marker 上写死（orient 0 / 180），不依赖路径末端切线。
const ELBOW_RADIUS = 6; // 转角圆角半径（按相邻段长收缩）
const DEPART_STUB = 12; // 离开前置横条右缘的水平短截
const LANE_GAP = 6; // 避让搜索的竖向车道步进
const FAN_SPREAD = 6; // 同侧多条线沿横条高度的最大锚点偏移（条高 20，半高 10）
const ARROW_LEN = 8; // 箭头三角形长度（与 SVG marker 尺寸一致）
const MIN_TAIL = 14; // 末段最短整直线 = 圆角 6 + 箭头底边前留足 8

/** 坐标统一保留两位小数（整数不带小数点），保证 SSR 与客户端字符串一致 */
const fmt = (value: number) => String(Math.round(value * 100) / 100);

/** 把一串正交拐点连成带圆角的折线；相邻重复点剔除，段长不足时退化为尖角 */
function roundedElbow(
  points: ReadonlyArray<readonly [number, number]>,
): string {
  const pts = points.filter(
    (p, i) => i === 0 || p[0] !== points[i - 1][0] || p[1] !== points[i - 1][1],
  );
  if (pts.length < 2) return "";
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  let [cursorX, cursorY] = pts[0];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const [ax, ay] = pts[i - 1];
    const [px, py] = pts[i];
    const [bx, by] = pts[i + 1];
    const inLen = Math.hypot(px - ax, py - ay);
    const outLen = Math.hypot(bx - px, by - py);
    const r = Math.min(ELBOW_RADIUS, inLen, outLen);
    if (r < 1) {
      d += ` L ${fmt(px)} ${fmt(py)}`;
      [cursorX, cursorY] = [px, py];
      continue;
    }
    // 圆角吞掉整段入边时（inLen === r）落点与游标重合，跳过零长度 L
    const inX = px - ((px - ax) / inLen) * r;
    const inY = py - ((py - ay) / inLen) * r;
    if (inX !== cursorX || inY !== cursorY) {
      d += ` L ${fmt(inX)} ${fmt(inY)}`;
    }
    d += ` Q ${fmt(px)} ${fmt(py)} ${fmt(px + ((bx - px) / outLen) * r)} ${fmt(
      py + ((by - py) / outLen) * r,
    )}`;
    cursorX = px + ((bx - px) / outLen) * r;
    cursorY = py + ((by - py) / outLen) * r;
  }
  const [lastX, lastY] = pts[pts.length - 1];
  if (lastX !== cursorX || lastY !== cursorY) {
    d += ` L ${fmt(lastX)} ${fmt(lastY)}`;
  }
  return d;
}

type EdgeRoute = {
  x1: number;
  ay1: number;
  /** 进入点 x：前向为后置横条左缘，后向为右缘 */
  ex: number;
  ay2: number;
  /** 竖向车道的 x 坐标 */
  vx: number;
};

function elbowPath(route: EdgeRoute): string {
  // 前置右缘 → 竖向车道 → 进入后置；无竖段时退化为纯水平线（防御分支）
  if (route.ay1 === route.ay2) {
    return `M ${fmt(route.x1)} ${fmt(route.ay1)} L ${fmt(route.ex)} ${fmt(route.ay1)}`;
  }
  return roundedElbow([
    [route.x1, route.ay1],
    [route.vx, route.ay1],
    [route.vx, route.ay2],
    [route.ex, route.ay2],
  ]);
}

type EdgeDraft = {
  dep: Dependency;
  inputIndex: number;
  pi: number;
  si: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  backward: boolean;
  ay1: number;
  ay2: number;
  vx: number;
  entryX: number;
};

/** 同一侧多条线沿横条高度扇开锚点（±FAN_SPREAD）；单条保持行中心 */
function fanAnchors(
  drafts: EdgeDraft[],
  groupOf: (draft: EdgeDraft) => number,
  otherRowOf: (draft: EdgeDraft) => number,
  apply: (draft: EdgeDraft, dy: number) => void,
): void {
  const groups = new Map<number, EdgeDraft[]>();
  for (const draft of drafts) {
    const key = groupOf(draft);
    const list = groups.get(key);
    if (list) list.push(draft);
    else groups.set(key, [draft]);
  }
  for (const list of groups.values()) {
    if (list.length === 1) {
      apply(list[0], 0);
      continue;
    }
    list.sort(
      (a, b) => otherRowOf(a) - otherRowOf(b) || a.inputIndex - b.inputIndex,
    );
    list.forEach((draft, k) => {
      apply(draft, -FAN_SPREAD + (2 * FAN_SPREAD * k) / (list.length - 1));
    });
  }
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
  const pct = (ms: number) => ((ms - min) / span) * 100;
  const clamp = (value: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(hi, value));

  // Pass 0：收集可见候选边（端点几何与过滤规则同旧版）
  const drafts: EdgeDraft[] = [];
  dependencies.forEach((dep, inputIndex) => {
    if (dep.predecessorId === dep.successorId) return;

    const pi = rowIndex.get(dep.predecessorId);
    const si = rowIndex.get(dep.successorId);
    if (pi === undefined || si === undefined) return;

    const predecessor = rows[pi];
    const successor = rows[si];

    const pLeft = (pct(predecessor.span.start) / 100) * chartWidth;
    const pWidth = Math.max(
      ((pct(predecessor.span.end) - pct(predecessor.span.start)) / 100) *
        chartWidth,
      barMinWidthPx,
    );
    const x1 = clamp(pLeft + pWidth, 2, chartWidth - 2);
    // 终点取后置横条左缘：配合箭头 refX=8（尖端即路径终点），前向箭头正好贴在条上
    const x2 = clamp(
      (pct(successor.span.start) / 100) * chartWidth,
      2,
      chartWidth - 2,
    );

    const y1 = pi * rowHeight + rowHeight / 2;
    const y2 = si * rowHeight + rowHeight / 2;
    drafts.push({
      dep,
      inputIndex,
      pi,
      si,
      x1,
      y1,
      x2,
      y2,
      backward: x2 < x1 + 12,
      ay1: y1,
      ay2: y2,
      vx: x1 + DEPART_STUB,
      entryX: x2,
    });
  });

  // Pass 1：锚点扇出——出边沿前置横条高度、入边沿后置横条高度错开
  fanAnchors(
    drafts,
    (draft) => draft.pi,
    (draft) => draft.si,
    (draft, dy) => {
      draft.ay1 += dy;
    },
  );
  fanAnchors(
    drafts,
    (draft) => draft.si,
    (draft) => draft.pi,
    (draft, dy) => {
      draft.ay2 += dy;
    },
  );

  // 每行横条的像素区间，供竖段车道避让
  const barSpans = rows.map((row) => {
    const left = (pct(row.span.start) / 100) * chartWidth;
    const width = Math.max(
      ((pct(row.span.end) - pct(row.span.start)) / 100) * chartWidth,
      barMinWidthPx,
    );
    return { left, right: left + width };
  });
  const laneFree = (vx: number, from: number, to: number) => {
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    for (let r = lo + 1; r < hi; r += 1) {
      const bar = barSpans[r];
      if (vx + 2 >= bar.left && vx - 2 <= bar.right) return false;
    }
    return true;
  };

  // 在 [from, to] 里找第一条不穿过中间横条的车道
  const searchLane = (draft: EdgeDraft, from: number, to: number) => {
    for (let candidate = from; candidate <= to; candidate += LANE_GAP) {
      if (laneFree(candidate, draft.pi, draft.si)) return candidate;
    }
    return null;
  };

  // Pass 2：竖向车道 + 进入段——先搜不穿过中间横条的通道（优先保证末段
  // MIN_TAIL 整直线，圆角 6 + 箭头底边 8），找不到再退而求其次、最后用默认位。
  // 线停在箭头底边（距横条 ARROW_LEN），三角形向前补完、尖端贴横条边缘：
  // 前向贴左缘尖朝右，后向（时间倒挂）贴右缘尖朝左。
  // 不变式：前向车道恒在底边左侧（末段向右画），后向恒在右侧（向左画）——
  // 箭头方向按前向/后向写死在 marker 上，几何一旦越侧箭头就会反向
  for (const draft of drafts) {
    const tipX = draft.backward
      ? clamp(barSpans[draft.si].right, 2, chartWidth - 2)
      : draft.x2;
    const lineEnd = draft.backward
      ? Math.min(tipX + ARROW_LEN, chartWidth - 2)
      : Math.max(tipX - ARROW_LEN, 2);
    const lo = draft.x1 + DEPART_STUB;
    if (draft.backward) {
      // 后置横条可能比前置伸得更靠右（lineEnd > lo），逐级收缩时也不许越过底边
      const hi = chartWidth - 2;
      draft.vx =
        searchLane(draft, Math.max(lo, lineEnd + MIN_TAIL), hi) ??
        searchLane(draft, lineEnd + 2, hi) ??
        Math.max(lineEnd + 1, Math.min(lo, hi));
    } else {
      const hi = Math.max(lineEnd - MIN_TAIL, draft.x1 + 2);
      draft.vx = searchLane(draft, lo, hi) ?? Math.min(lo, hi);
    }
    draft.entryX = lineEnd;
  }

  // Pass 3：拼装路径
  return drafts.map((draft) => ({
    ...draft.dep,
    x1: draft.x1,
    y1: draft.y1,
    x2: draft.x2,
    y2: draft.y2,
    backward: draft.backward,
    path: elbowPath({
      x1: draft.x1,
      ay1: draft.ay1,
      ex: draft.entryX,
      ay2: draft.ay2,
      vx: draft.vx,
    }),
  }));
}
