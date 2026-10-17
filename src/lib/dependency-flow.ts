// 依赖流程图的纯布局逻辑：只关心任务之间的前置 → 后置关系，不涉时间轴。
// 左→右分层（longest-path + 重心排序），并把分层包装成「阶段」：
// 最长链作为主线编号，另外给出开始/结束锚点与每个任务的流程状态。
// 不依赖 React / DOM，便于单元测试；客户端组件只负责 hover 与渲染。

import type { Dependency } from "./relationship-graph";

export type { Dependency };

export const NODE_W = 176;
export const NODE_H = 64;
export const LAYER_GAP_X = 96;
export const NODE_GAP_Y = 20;
export const PADDING_X = 24;
export const PADDING_TOP = 12;
export const PADDING_BOTTOM = 12;
/** 阶段标题占用的高度（含与首行卡片之间的间距） */
export const PHASE_HEADER_H = 24;
export const PHASE_HEADER_GAP = 8;
/** 阶段底色比卡片左右各宽出多少 */
export const PHASE_BAND_PAD_X = 12;
export const PHASE_BAND_PAD_BOTTOM = 8;
/** 开始 / 结束胶囊的尺寸与到首末列的间距 */
export const TERMINAL_W = 56;
export const TERMINAL_H = 32;
export const TERMINAL_GAP_X = 48;
const BARYCENTER_SWEEPS = 4;

export type FlowTask = {
  id: string;
  title: string;
  status: string;
  parentTaskId: string | null;
  sortOrder: number;
};

/** 由依赖与完成情况推导出的执行状态 */
export type FlowState = "done" | "doing" | "ready" | "blocked";

export type FlowNode = {
  task: FlowTask;
  /** 从 0 开始的列号（阶段号） */
  layer: number;
  /** 列内从 0 开始的行号 */
  order: number;
  x: number;
  y: number;
  centerX: number;
  centerY: number;
  /** 主线序号（1 起）；不在主线上为 null */
  step: number | null;
  flowState: FlowState;
  /** flowState === "blocked" 时，尚未完成的前置数量 */
  blockedBy: number;
};

export type FlowEdge = Dependency & {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  path: string;
  /** DFS 判定的回边（历史循环数据），分层时忽略 */
  cyclic: boolean;
  /** 前后置的 parentTaskId 不同，属历史跨层级依赖 */
  crossLevel: boolean;
  /** 属于最长链（主线） */
  mainPath: boolean;
};

/** 一列 = 一个阶段，用来画底色与阶段标题 */
export type FlowPhase = {
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  done: number;
  total: number;
  /** 第一个仍有未完成任务的阶段 */
  current: boolean;
};

export type FlowTerminal = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** 开始 / 结束锚点连向首列源点、末列汇点的连线 */
export type FlowTerminalEdge = {
  from: "start" | "end";
  path: string;
};

export type FlowCounts = {
  tasks: number;
  dependencies: number;
  edges: number;
  crossLevel: number;
  cyclic: number;
  selfLoops: number;
  duplicates: number;
  missingEndpoints: number;
  isolated: number;
};

export type DependencyFlowLayout = {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** 不参与任何有效依赖的任务；页面单独列出，不画进画布 */
  isolatedTaskIds: string[];
  phases: FlowPhase[];
  start: FlowTerminal | null;
  end: FlowTerminal | null;
  terminalEdges: FlowTerminalEdge[];
  /** 主线上的任务 id（按流程顺序）；没有成链时为 [] */
  mainPathTaskIds: string[];
  progress: { done: number; total: number; currentLayer: number | null };
  width: number;
  height: number;
  counts: FlowCounts;
};

const edgeKey = (predecessorId: string, successorId: string) =>
  `${predecessorId}\0${successorId}`;

const clamp = (value: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, value));

const forwardCurve = (x1: number, y1: number, x2: number, y2: number) => {
  const dx = Math.max(24, (x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};

export function computeDependencyFlow(input: {
  tasks: readonly FlowTask[];
  dependencies: readonly Dependency[];
}): DependencyFlowLayout {
  // 1. 任务按 sortOrder + 输入顺序稳定排序；重复 id 取首个
  const sorted = input.tasks
    .map((task, inputIndex) => ({ task, inputIndex }))
    .sort(
      (a, b) =>
        a.task.sortOrder - b.task.sortOrder || a.inputIndex - b.inputIndex,
    );

  const byId = new Map<string, FlowTask>();
  const rank = new Map<string, number>();
  const orderedTasks: FlowTask[] = [];
  for (const { task } of sorted) {
    if (byId.has(task.id)) continue;
    byId.set(task.id, task);
    rank.set(task.id, orderedTasks.length);
    orderedTasks.push(task);
  }

  const counts: FlowCounts = {
    tasks: orderedTasks.length,
    dependencies: input.dependencies.length,
    edges: 0,
    crossLevel: 0,
    cyclic: 0,
    selfLoops: 0,
    duplicates: 0,
    missingEndpoints: 0,
    isolated: 0,
  };

  // 2. 规范化边：去自环、去缺失端点、去重复
  const seen = new Set<string>();
  const valid: { predecessorId: string; successorId: string; crossLevel: boolean }[] = [];
  for (const dep of input.dependencies) {
    if (dep.predecessorId === dep.successorId) {
      counts.selfLoops += 1;
      continue;
    }
    const pred = byId.get(dep.predecessorId);
    const succ = byId.get(dep.successorId);
    if (!pred || !succ) {
      counts.missingEndpoints += 1;
      continue;
    }
    const key = edgeKey(dep.predecessorId, dep.successorId);
    if (seen.has(key)) {
      counts.duplicates += 1;
      continue;
    }
    seen.add(key);
    valid.push({
      predecessorId: dep.predecessorId,
      successorId: dep.successorId,
      crossLevel: pred.parentTaskId !== succ.parentTaskId,
    });
  }
  valid.sort(
    (a, b) =>
      rank.get(a.predecessorId)! - rank.get(b.predecessorId)! ||
      rank.get(a.successorId)! - rank.get(b.successorId)!,
  );

  // 3. 孤立任务：不进入画布
  const connected = new Set<string>();
  for (const edge of valid) {
    connected.add(edge.predecessorId);
    connected.add(edge.successorId);
  }
  const isolatedTaskIds = orderedTasks
    .filter((task) => !connected.has(task.id))
    .map((task) => task.id);
  counts.isolated = isolatedTaskIds.length;

  const connectedTasks = orderedTasks.filter((task) => connected.has(task.id));

  const out = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of valid) {
    const list = out.get(edge.predecessorId) ?? [];
    list.push(edge.successorId);
    out.set(edge.predecessorId, list);

    const back = incoming.get(edge.successorId) ?? [];
    back.push(edge.predecessorId);
    incoming.set(edge.successorId, back);
  }

  // 4. 确定性 DFS 标记回边（指向当前递归栈上的节点）
  const color = new Map<string, 1 | 2>();
  const cyclicKeys = new Set<string>();
  function visit(node: string) {
    color.set(node, 1);
    for (const next of out.get(node) ?? []) {
      const state = color.get(next);
      if (state === 1) {
        cyclicKeys.add(edgeKey(node, next));
      } else if (state === undefined) {
        visit(next);
      }
    }
    color.set(node, 2);
  }
  for (const task of connectedTasks) {
    if (!color.has(task.id)) visit(task.id);
  }

  // 5. 只用非回边做最长路径分层；Kahn 的顺序同时留给主线使用
  const dagOut = new Map<string, string[]>();
  const dagIn = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const layer = new Map<string, number>();
  for (const task of connectedTasks) {
    indegree.set(task.id, 0);
    layer.set(task.id, 0);
  }
  for (const edge of valid) {
    if (cyclicKeys.has(edgeKey(edge.predecessorId, edge.successorId))) continue;
    const outs = dagOut.get(edge.predecessorId) ?? [];
    outs.push(edge.successorId);
    dagOut.set(edge.predecessorId, outs);

    const ins = dagIn.get(edge.successorId) ?? [];
    ins.push(edge.predecessorId);
    dagIn.set(edge.successorId, ins);

    indegree.set(edge.successorId, (indegree.get(edge.successorId) ?? 0) + 1);
  }

  const ready = connectedTasks
    .filter((task) => indegree.get(task.id) === 0)
    .map((task) => task.id);
  const topo: string[] = [];
  while (ready.length > 0) {
    const node = ready.shift()!;
    topo.push(node);
    for (const next of dagOut.get(node) ?? []) {
      layer.set(next, Math.max(layer.get(next)!, layer.get(node)! + 1));
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) {
        ready.push(next);
        ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
      }
    }
  }

  // 5b. 最长链（按任务数）作为主线：拓扑序上做 DP，并列时取 rank 更小的前置
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  for (const task of connectedTasks) dist.set(task.id, 1);
  for (const id of topo) {
    const base = dist.get(id)!;
    for (const next of dagOut.get(id) ?? []) {
      const candidate = base + 1;
      const current = dist.get(next)!;
      if (candidate > current) {
        dist.set(next, candidate);
        prev.set(next, id);
      } else if (candidate === current) {
        const existing = prev.get(next);
        if (existing !== undefined && rank.get(id)! < rank.get(existing)!) {
          prev.set(next, id);
        }
      }
    }
  }

  let mainEnd: string | null = null;
  for (const task of connectedTasks) {
    const id = task.id;
    if (mainEnd === null || dist.get(id)! > dist.get(mainEnd)!) {
      mainEnd = id;
    }
  }
  const walked: string[] = [];
  if (mainEnd !== null) {
    let cursor: string | undefined = mainEnd;
    while (cursor !== undefined) {
      walked.push(cursor);
      cursor = prev.get(cursor);
    }
    walked.reverse();
  }
  // 只有一条边时「主线」没有叙事价值，不标序号
  const mainPath = walked.length >= 2 ? walked : [];
  const stepById = new Map(mainPath.map((id, index) => [id, index + 1]));
  const mainPathKeys = new Set<string>();
  for (let i = 1; i < mainPath.length; i += 1) {
    mainPathKeys.add(edgeKey(mainPath[i - 1], mainPath[i]));
  }

  // 5c. 流程状态：已完成 / 进行中 / 可开始（前置都完成）/ 等待前置
  const flowMeta = new Map<
    string,
    { flowState: FlowState; blockedBy: number }
  >();
  for (const task of connectedTasks) {
    const unfinished = (dagIn.get(task.id) ?? []).filter(
      (predId) => byId.get(predId)!.status !== "done",
    ).length;
    let flowState: FlowState;
    if (task.status === "done") flowState = "done";
    else if (task.status === "doing") flowState = "doing";
    else if (unfinished === 0) flowState = "ready";
    else flowState = "blocked";
    flowMeta.set(task.id, {
      flowState,
      blockedBy: flowState === "blocked" ? unfinished : 0,
    });
  }

  // 6. 层内重心排序：降低边交叉，且保证确定性
  let layerCount = 0;
  for (const task of connectedTasks) {
    layerCount = Math.max(layerCount, layer.get(task.id)! + 1);
  }
  const buckets: string[][] = Array.from({ length: layerCount }, () => []);
  for (const task of connectedTasks) {
    buckets[layer.get(task.id)!].push(task.id);
  }

  const positionMap = (ids: readonly string[]) =>
    new Map(ids.map((id, index) => [id, index]));
  const barycenter = (
    ids: readonly string[],
    neighbors: Map<string, string[]>,
    neighborPositions: Map<string, number>,
    fallback: Map<string, number>,
  ) => {
    const result = new Map<string, number>();
    for (const id of ids) {
      const positions = (neighbors.get(id) ?? [])
        .map((other) => neighborPositions.get(other))
        .filter((value): value is number => value !== undefined);
      const value =
        positions.length > 0
          ? positions.reduce((sum, value) => sum + value, 0) / positions.length
          : fallback.get(id)!;
      result.set(id, value);
    }
    return result;
  };

  for (let sweep = 0; sweep < BARYCENTER_SWEEPS; sweep += 1) {
    if (sweep % 2 === 0) {
      for (let l = 1; l < buckets.length; l += 1) {
        const oldPositions = positionMap(buckets[l]);
        const values = barycenter(
          buckets[l],
          dagIn,
          positionMap(buckets[l - 1]),
          oldPositions,
        );
        buckets[l].sort(
          (a, b) =>
            values.get(a)! - values.get(b)! ||
            oldPositions.get(a)! - oldPositions.get(b)! ||
            rank.get(a)! - rank.get(b)!,
        );
      }
    } else {
      for (let l = buckets.length - 2; l >= 0; l -= 1) {
        const oldPositions = positionMap(buckets[l]);
        const values = barycenter(
          buckets[l],
          dagOut,
          positionMap(buckets[l + 1]),
          oldPositions,
        );
        buckets[l].sort(
          (a, b) =>
            values.get(a)! - values.get(b)! ||
            oldPositions.get(a)! - oldPositions.get(b)! ||
            rank.get(a)! - rank.get(b)!,
        );
      }
    }
  }

  // 7. 坐标：首末各留出开始/结束胶囊的位置，顶部留出阶段标题
  const maxRows = buckets.reduce((max, ids) => Math.max(max, ids.length), 0);
  const hasNodes = buckets.length > 0;
  const nodeX0 = PADDING_X + TERMINAL_W + TERMINAL_GAP_X;
  const nodeY0 = PADDING_TOP + PHASE_HEADER_H + PHASE_HEADER_GAP;
  const bandHeight =
    PHASE_HEADER_H +
    PHASE_HEADER_GAP +
    maxRows * NODE_H +
    Math.max(0, maxRows - 1) * NODE_GAP_Y +
    PHASE_BAND_PAD_BOTTOM;
  const width = hasNodes
    ? PADDING_X * 2 +
      TERMINAL_W * 2 +
      TERMINAL_GAP_X * 2 +
      buckets.length * NODE_W +
      (buckets.length - 1) * LAYER_GAP_X
    : 0;
  const height = hasNodes ? PADDING_TOP + bandHeight + PADDING_BOTTOM : 0;

  const nodes: FlowNode[] = [];
  buckets.forEach((ids, l) => {
    ids.forEach((id, order) => {
      const x = nodeX0 + l * (NODE_W + LAYER_GAP_X);
      const y = nodeY0 + order * (NODE_H + NODE_GAP_Y);
      const meta = flowMeta.get(id)!;
      nodes.push({
        task: byId.get(id)!,
        layer: l,
        order,
        x,
        y,
        centerX: x + NODE_W / 2,
        centerY: y + NODE_H / 2,
        step: stepById.get(id) ?? null,
        flowState: meta.flowState,
        blockedBy: meta.blockedBy,
      });
    });
  });
  const nodeById = new Map(nodes.map((node) => [node.task.id, node]));

  // 8. 阶段（= 层）与进度
  const phaseDone = buckets.map(
    (ids) => ids.filter((id) => byId.get(id)!.status === "done").length,
  );
  const currentLayer = phaseDone.findIndex(
    (done, l) => done < buckets[l].length,
  );
  const phases: FlowPhase[] = buckets.map((ids, l) => ({
    layer: l,
    x: nodeX0 + l * (NODE_W + LAYER_GAP_X) - PHASE_BAND_PAD_X,
    y: PADDING_TOP,
    width: NODE_W + PHASE_BAND_PAD_X * 2,
    height: bandHeight,
    done: phaseDone[l],
    total: ids.length,
    current: l === currentLayer,
  }));

  const progress = {
    done: connectedTasks.filter((task) => task.status === "done").length,
    total: connectedTasks.length,
    currentLayer: currentLayer >= 0 ? currentLayer : null,
  };

  // 9. 开始 / 结束锚点：起点连向所有源点，终点由末列汇点汇入
  const sourceIds = connectedTasks
    .map((task) => task.id)
    .filter((id) => (dagIn.get(id) ?? []).length === 0);
  const sinkIds = connectedTasks
    .map((task) => task.id)
    .filter((id) => (dagOut.get(id) ?? []).length === 0);

  const averageCenterY = (ids: readonly string[]) =>
    ids.length > 0
      ? ids.reduce((sum, id) => sum + nodeById.get(id)!.centerY, 0) /
        ids.length
      : height / 2;
  const firstMain = mainPath.length > 0 ? nodeById.get(mainPath[0])! : null;
  const lastMain =
    mainPath.length > 0 ? nodeById.get(mainPath[mainPath.length - 1])! : null;
  const clampTerminalY = (centerY: number) =>
    clamp(
      centerY - TERMINAL_H / 2,
      PADDING_TOP,
      height - PADDING_BOTTOM - TERMINAL_H,
    );

  const start: FlowTerminal | null = hasNodes
    ? {
        x: PADDING_X,
        y: clampTerminalY(firstMain?.centerY ?? averageCenterY(sourceIds)),
        width: TERMINAL_W,
        height: TERMINAL_H,
      }
    : null;
  const end: FlowTerminal | null = hasNodes
    ? {
        x:
          nodeX0 +
          (buckets.length - 1) * (NODE_W + LAYER_GAP_X) +
          NODE_W +
          TERMINAL_GAP_X,
        y: clampTerminalY(lastMain?.centerY ?? averageCenterY(sinkIds)),
        width: TERMINAL_W,
        height: TERMINAL_H,
      }
    : null;

  const terminalEdges: FlowTerminalEdge[] = [];
  if (start && end) {
    const startX = start.x + start.width;
    const startY = start.y + start.height / 2;
    for (const id of sourceIds) {
      const node = nodeById.get(id)!;
      terminalEdges.push({
        from: "start",
        path: forwardCurve(startX, startY, node.x, node.centerY),
      });
    }
    const endX = end.x;
    const endY = end.y + end.height / 2;
    for (const id of sinkIds) {
      const node = nodeById.get(id)!;
      // 非末列的汇点没有可走的空白通道，避免长线穿过画布
      if (node.layer !== buckets.length - 1) continue;
      terminalEdges.push({
        from: "end",
        path: forwardCurve(node.x + NODE_W, node.centerY, endX, endY),
      });
    }
  }

  // 10. 边几何：正常向前；回边绕到卡片外侧并抬升
  const edges: FlowEdge[] = [];
  let cyclicLane = 0;
  for (const edge of valid) {
    const pred = nodeById.get(edge.predecessorId)!;
    const succ = nodeById.get(edge.successorId)!;
    const key = edgeKey(edge.predecessorId, edge.successorId);
    const cyclic = cyclicKeys.has(key);

    let x1: number;
    let y1: number;
    let x2: number;
    let y2: number;
    let path: string;

    if (cyclic) {
      x1 = pred.x;
      y1 = pred.centerY;
      x2 = succ.x + NODE_W;
      y2 = succ.centerY;
      const lane = cyclicLane;
      cyclicLane += 1;
      const direction = y1 <= y2 ? -1 : 1;
      const lift = 18 + (lane % 6) * 8;
      const cy1 = clamp(
        y1 + direction * lift,
        PADDING_TOP / 2,
        height - PADDING_TOP / 2,
      );
      const cy2 = clamp(
        y2 + direction * lift,
        PADDING_TOP / 2,
        height - PADDING_TOP / 2,
      );
      path = `M ${x1} ${y1} C ${x1 - 24} ${cy1}, ${x2 + 24} ${cy2}, ${x2} ${y2}`;
    } else {
      x1 = pred.x + NODE_W;
      y1 = pred.centerY;
      x2 = succ.x;
      y2 = succ.centerY;
      path = forwardCurve(x1, y1, x2, y2);
    }

    edges.push({
      ...edge,
      x1,
      y1,
      x2,
      y2,
      path,
      cyclic,
      mainPath: mainPathKeys.has(key),
    });
  }

  counts.edges = edges.length;
  counts.crossLevel = edges.filter((edge) => edge.crossLevel).length;
  counts.cyclic = edges.filter((edge) => edge.cyclic).length;

  return {
    nodes,
    edges,
    isolatedTaskIds,
    phases,
    start,
    end,
    terminalEdges,
    mainPathTaskIds: mainPath,
    progress,
    width,
    height,
    counts,
  };
}
