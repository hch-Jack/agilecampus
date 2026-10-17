// 流程层级：按 parentTaskId 把任务切成「一层一流程」。
// 顶层任务自成一层；每个父任务的直接子任务又是一层。
// 只做数据结构，不依赖 React / DOM，便于服务端与单元测试共用。

import type { FlowTask } from "./dependency-flow";

export type FlowTreeNode = {
  task: FlowTask;
  children: FlowTreeNode[];
};

export type FlowChildStat = {
  /** 直属子任务数 */
  total: number;
  /** 其中已完成的数量 */
  done: number;
};

export type FlowScope = {
  /** 当前层的父任务；null 表示顶层 */
  parent: FlowTask | null;
  /** 从顶层到当前父任务的路径（含当前父任务），用于面包屑 */
  ancestors: FlowTask[];
  /** 当前层任务（兄弟任务 / 顶层任务），按 sortOrder 排序 */
  tasks: FlowTask[];
  /** 有直属子任务的任务统计；没有子任务的 id 不出现 */
  childStats: Record<string, FlowChildStat>;
  /** 全项目任务森林，供左侧层级树展示 */
  roots: FlowTreeNode[];
};

/**
 * 解析某一层的流程范围。
 * - parentId = null：顶层任务；
 * - parentId = 某个任务：它的直接子任务；
 * - 父任务不存在、或它没有子任务时返回 null（调用方按 404 处理）。
 */
export function resolveFlowScope(
  input: readonly FlowTask[],
  parentId: string | null,
): FlowScope | null {
  // 1. 去重后按 sortOrder 稳定排序
  const byId = new Map<string, FlowTask>();
  const ordered: FlowTask[] = [];
  for (const task of input) {
    if (byId.has(task.id)) continue;
    byId.set(task.id, task);
    ordered.push(task);
  }
  ordered.sort((a, b) => a.sortOrder - b.sortOrder);

  // 2. 有效父任务：父链成环的脏数据按根处理，缺失的祖先不牵连直接父子关系
  const effectiveParent = new Map<string, string | null>();
  for (const task of ordered) {
    const direct = task.parentTaskId;
    if (!direct || !byId.has(direct)) {
      effectiveParent.set(task.id, null);
      continue;
    }
    const seen = new Set<string>([task.id]);
    let cursor: string | null = direct;
    let cyclic = false;
    while (cursor && byId.has(cursor)) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = byId.get(cursor)!.parentTaskId;
    }
    effectiveParent.set(task.id, cyclic ? null : direct);
  }

  // 3. 按父任务分组（null 为顶层）
  const childrenOf = new Map<string | null, FlowTask[]>();
  for (const task of ordered) {
    const key = effectiveParent.get(task.id) ?? null;
    const list = childrenOf.get(key) ?? [];
    list.push(task);
    childrenOf.set(key, list);
  }

  // 4. 每个父任务的直属子任务统计
  const childStats: Record<string, FlowChildStat> = {};
  for (const task of ordered) {
    const children = childrenOf.get(task.id) ?? [];
    if (children.length === 0) continue;
    childStats[task.id] = {
      total: children.length,
      done: children.filter((child) => child.status === "done").length,
    };
  }

  // 5. 森林（防御父链成环的脏数据，visited 保证不重复、不递归失控）
  const visited = new Set<string>();
  const buildNode = (
    task: FlowTask,
    ancestors: ReadonlySet<string>,
  ): FlowTreeNode => {
    visited.add(task.id);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(task.id);
    const children = (childrenOf.get(task.id) ?? []).filter(
      (child) => !nextAncestors.has(child.id) && !visited.has(child.id),
    );
    return {
      task,
      children: children.map((child) => buildNode(child, nextAncestors)),
    };
  };
  const roots: FlowTreeNode[] = [];
  for (const task of childrenOf.get(null) ?? []) {
    if (!visited.has(task.id)) roots.push(buildNode(task, new Set()));
  }
  for (const task of ordered) {
    if (!visited.has(task.id)) roots.push(buildNode(task, new Set()));
  }

  // 6. 顶层
  if (parentId === null) {
    return {
      parent: null,
      ancestors: [],
      tasks: childrenOf.get(null) ?? [],
      childStats,
      roots,
    };
  }

  // 7. 某个父任务的子流程
  const parent = byId.get(parentId);
  if (!parent) return null;
  const tasks = childrenOf.get(parentId) ?? [];
  if (tasks.length === 0) return null;

  const ancestors: FlowTask[] = [];
  const seen = new Set<string>();
  let cursor: FlowTask | undefined = parent;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    ancestors.push(cursor);
    const next = effectiveParent.get(cursor.id);
    cursor = next ? byId.get(next) : undefined;
  }
  ancestors.reverse();

  return { parent, ancestors, tasks, childStats, roots };
}
