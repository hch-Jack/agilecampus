// 任务数据库（只读总览表）的筛选：纯函数层，交互与看板 FilterBar 同款——
// 每个维度一排点选 chips（点「张三」只看张三的任务），多选=任一命中。
// 条件经 URL 单参数 `dbf` 承载（JSON + encodeURIComponent，可分享/可刷新），
// 服务端内存过滤（沿用看板 URL-as-state 惯例；实验室规模不做 SQL 下推）。
// 形状非法的输入整体/逐项忽略，不让脏参数炸页面。
import type { PropertyType, TaskPriority, TaskStatus } from "@/db/schema";
import { TASK_PRIORITIES, TASK_STATUSES } from "./task-constants";

export const DB_FILTER_PARAM = "dbf";
const NONE = "none"; // 未指派/无里程碑/未设置
const CHECKED = "checked";
const UNCHECKED = "unchecked";

export type DbFilters = {
  status: string[]; // TaskStatus
  assignee: string[]; // userId 或 none
  priority: string[]; // low/medium/high
  label: string[]; // labelId
  milestone: string[]; // milestoneId 或 none
  overdue: boolean; // 仅看逾期：有截止日 < 今天 且未完成
  /** 自定义属性：defId → 选项/成员 id（或 none / checked / unchecked） */
  props: Record<string, string[]>;
};

export type DbFilterContext = {
  /** `prop:<id>` 的属性定义（id → 类型与选项序）；引用已删属性的维度被忽略 */
  defs: Map<string, { type: PropertyType; optionIds: string[] }>;
};

export type DbFilterableTask = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeId: string | null;
  milestoneId: string | null;
  startDate: string | null;
  dueDate: string | null;
  labels: { id: string }[];
  properties?: Record<string, unknown> | null;
};

export const EMPTY_DB_FILTERS: DbFilters = {
  status: [],
  assignee: [],
  priority: [],
  label: [],
  milestone: [],
  overdue: false,
  props: {},
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** uuid 或 none（未指派/无里程碑/未设置） */
const idOrNone = (v: unknown) => typeof v === "string" && (UUID_RE.test(v) || v === NONE) ? v : null;
const plainUuid = (v: unknown) => (typeof v === "string" && UUID_RE.test(v) ? v : null);
const strList = (v: unknown, item: (x: unknown) => string | null): string[] => {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item0 of v) {
    const s = item(item0);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
};

/** URL 参数值 → 筛选态：JSON 解析失败/维度非法逐项剔除 */
export function parseDbFilters(raw: string | null | undefined): DbFilters {
  if (!raw) return { ...EMPTY_DB_FILTERS, props: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_DB_FILTERS, props: {} };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY_DB_FILTERS, props: {} };
  const o = parsed as Record<string, unknown>;
  const propsRaw = (typeof o.props === "object" && o.props !== null ? o.props : {}) as Record<string, unknown>;
  const props: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(propsRaw)) {
    if (!UUID_RE.test(key)) continue;
    const values = strList(value, (x) =>
      typeof x === "string" && (UUID_RE.test(x) || x === NONE || x === CHECKED || x === UNCHECKED) ? x : null,
    );
    if (values.length) props[key] = values;
  }
  return {
    status: strList(o.status, (x) => (typeof x === "string" && TASK_STATUSES.includes(x as TaskStatus) ? x : null)),
    assignee: strList(o.assignee, idOrNone),
    priority: strList(o.priority, (x) => (typeof x === "string" && TASK_PRIORITIES.includes(x as TaskPriority) ? x : null)),
    label: strList(o.label, plainUuid),
    milestone: strList(o.milestone, idOrNone),
    overdue: o.overdue === true,
    props,
  };
}

/** 筛选态 → URL 参数值（不含键名）；全空返回 "" */
export function serializeDbFilters(f: DbFilters): string {
  const compact: Record<string, unknown> = {};
  if (f.status.length) compact.status = f.status;
  if (f.assignee.length) compact.assignee = f.assignee;
  if (f.priority.length) compact.priority = f.priority;
  if (f.label.length) compact.label = f.label;
  if (f.milestone.length) compact.milestone = f.milestone;
  if (f.overdue) compact.overdue = true;
  if (Object.keys(f.props).length) compact.props = f.props;
  if (Object.keys(compact).length === 0) return "";
  return JSON.stringify(compact);
}

const hasNone = (values: string[]) => values.includes(NONE);

/** 任务数据库筛选：每个维度任一命中即保留，全部维度取交集 */
export function applyDbFilters<T extends DbFilterableTask>(
  tasks: T[],
  f: DbFilters,
  ctx: DbFilterContext,
  today: string,
): T[] {
  return tasks.filter((t) => {
    if (f.status.length && !f.status.includes(t.status)) return false;
    if (f.assignee.length && !f.assignee.includes(t.assigneeId ?? NONE)) return false;
    if (f.priority.length && !f.priority.includes(t.priority)) return false;
    if (f.label.length && !t.labels.some((l) => f.label.includes(l.id))) return false;
    if (f.milestone.length && !f.milestone.includes(t.milestoneId ?? NONE)) return false;
    if (f.overdue && !(t.dueDate && t.dueDate < today && t.status !== "done")) return false;
    for (const [defId, values] of Object.entries(f.props)) {
      if (values.length === 0) continue;
      const def = ctx.defs.get(defId);
      if (!def) continue; // 已删属性：维度忽略
      const v = t.properties?.[defId];
      switch (def.type) {
        case "select": {
          if (!values.includes((v ?? NONE) as string)) return false;
          break;
        }
        case "multi_select": {
          const arr = Array.isArray(v) ? (v as unknown[]) : [];
          if (hasNone(values) && arr.length === 0) break; // 「未设置」命中
          if (!arr.some((x) => values.includes(String(x)))) return false;
          break;
        }
        case "person": {
          if (!values.includes((v ?? NONE) as string)) return false;
          break;
        }
        case "checkbox": {
          const checked = v === true;
          if (values.includes(CHECKED) && !checked) return false;
          if (values.includes(UNCHECKED) && checked) return false;
          break;
        }
        default:
          break; // text/number/date 不做点选筛选（UI 不提供，防御性忽略）
      }
    }
    return true;
  });
}
