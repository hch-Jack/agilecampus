// 任务数据库（只读总览表）的按类型筛选：纯函数层。
// 条件经 URL 单参数 `dbf` 承载（JSON + encodeURIComponent，可分享/可刷新），
// 服务端内存过滤（沿用看板 URL-as-state 惯例；实验室规模，方案 R7 不做 SQL 下推）。
// 子句形状非法 → 整体忽略（恒真），不让脏参数炸页面。
import type { PropertyType, TaskPriority, TaskStatus } from "@/db/schema";
import { TASK_PRIORITIES, TASK_STATUSES } from "./task-constants";

export const DB_FILTER_PARAM = "dbf";

export type DbFilterClause = { field: string; op: string; value?: unknown };

export type DbFilterContext = {
  /** `prop:<id>` 的属性定义（id → 类型与选项序）；引用已删属性的子句被忽略 */
  defs: Map<string, { type: PropertyType; optionIds: string[] }>;
  /** 里程碑序（milestoneId → 序号），milestone 排序候选与选项列表用 */
  milestoneOrder: Map<string, number>;
  /** userId → 成员名 */
  members: Map<string, string>;
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

export type DbFilterKind =
  | "text"
  | "number"
  | "select"
  | "multi"
  | "date"
  | "person"
  | "checkbox"
  | "enum";

export const DB_OP_LABELS = {
  contains: "包含",
  notContains: "不包含",
  eq: "等于",
  ne: "不等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  in: "是其中之一",
  notIn: "不是其中之一",
  hasAny: "包含任一",
  hasAll: "包含全部",
  is: "等于",
  before: "早于",
  after: "晚于",
  isEmpty: "为空",
  isNotEmpty: "不为空",
  isTrue: "已勾选",
  isFalse: "未勾选",
} as const;
export type DbFilterOp = keyof typeof DB_OP_LABELS;

const KIND_OPS: Record<DbFilterKind, readonly DbFilterOp[]> = {
  text: ["contains", "notContains", "isEmpty", "isNotEmpty"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "isEmpty", "isNotEmpty"],
  select: ["in", "notIn", "isEmpty", "isNotEmpty"],
  multi: ["hasAny", "hasAll", "isEmpty", "isNotEmpty"],
  date: ["is", "before", "after", "isEmpty", "isNotEmpty"],
  person: ["in", "notIn", "isEmpty", "isNotEmpty"],
  checkbox: ["isTrue", "isFalse"],
  // 原生枚举（status/priority）：三态固定，isNotEmpty 无意义
  enum: ["in", "notIn"],
};

export function opsForDbKind(kind: DbFilterKind): readonly DbFilterOp[] {
  return KIND_OPS[kind];
}

const FIELD_MAX = 80;
const CLAUSE_MAX = 10;

/** URL → 子句列表：JSON 解析失败/形状非法的子句剔除，超出上限截断 */
export function parseDbFilters(raw: string | null | undefined): DbFilterClause[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const clauses: DbFilterClause[] = [];
  for (const item of parsed) {
    if (clauses.length >= CLAUSE_MAX) break;
    if (typeof item !== "object" || item === null) continue;
    const { field, op, value } = item as { field?: unknown; op?: unknown; value?: unknown };
    if (typeof field !== "string" || field.length === 0 || field.length > FIELD_MAX) continue;
    if (typeof op !== "string" || op.length === 0 || op.length > 24) continue;
    clauses.push(value === undefined ? { field, op } : { field, op, value });
  }
  return clauses;
}

/** 子句列表 → URL 参数值（不含键名）；空返回 "" */
export function serializeDbFilters(clauses: DbFilterClause[]): string {
  if (clauses.length === 0) return "";
  return JSON.stringify(clauses);
}

/** 字段 → 取值器与类型档位。返回 null = 字段失效（引用已删属性/未知字段），子句忽略 */
export function dbFieldMeta(
  field: string,
  ctx: DbFilterContext,
): {
  kind: DbFilterKind;
  options?: string[];
  get: (t: DbFilterableTask) => unknown;
} | null {
  if (field.startsWith("prop:")) {
    const def = ctx.defs.get(field.slice(5));
    if (!def) return null;
    const key = field.slice(5);
    switch (def.type) {
      case "text":
        return { kind: "text", get: (t) => t.properties?.[key] };
      case "number":
        return { kind: "number", get: (t) => t.properties?.[key] };
      case "select":
        return { kind: "select", options: def.optionIds, get: (t) => t.properties?.[key] };
      case "multi_select":
        return { kind: "multi", options: def.optionIds, get: (t) => t.properties?.[key] };
      case "date":
        return { kind: "date", get: (t) => t.properties?.[key] };
      case "person":
        return { kind: "person", get: (t) => t.properties?.[key] };
      case "checkbox":
        return { kind: "checkbox", get: (t) => t.properties?.[key] };
    }
  }
  switch (field) {
    case "title":
      return { kind: "text", get: (t) => t.title };
    case "status":
      return { kind: "enum", options: [...TASK_STATUSES], get: (t) => t.status };
    case "priority":
      return { kind: "enum", options: [...TASK_PRIORITIES], get: (t) => t.priority };
    case "assignee":
      return { kind: "person", get: (t) => t.assigneeId };
    case "milestone":
      return { kind: "person", options: [...ctx.milestoneOrder.keys()], get: (t) => t.milestoneId };
    case "label":
      return { kind: "multi", get: (t) => t.labels.map((l) => l.id) };
    case "startDate":
      return { kind: "date", get: (t) => t.startDate };
    case "dueDate":
      return { kind: "date", get: (t) => t.dueDate };
    default:
      return null;
  }
}

const isEmptyValue = (v: unknown) => v === null || v === undefined || v === "";

/** 单条子句匹配。形状非法（op 与字段类型不配、值形状不对）→ 恒真（忽略子句） */
function matchClause(t: DbFilterableTask, clause: DbFilterClause, ctx: DbFilterContext): boolean {
  const meta = dbFieldMeta(clause.field, ctx);
  if (!meta) return true;
  const { kind, get } = meta;
  const v = get(t);
  const op = clause.op;
  const arr = Array.isArray(clause.value) ? (clause.value as unknown[]) : null;

  switch (op) {
    case "contains":
    case "notContains": {
      if (kind !== "text" || typeof clause.value !== "string") return true;
      const hit = typeof v === "string" && v.includes(clause.value);
      return op === "contains" ? hit : !hit;
    }
    case "eq":
    case "ne": {
      if (kind !== "number" || typeof clause.value !== "number") return true;
      const hit = typeof v === "number" && v === clause.value;
      return op === "eq" ? hit : !hit;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      // 子句形状非法 → 忽略（恒真）；任务无值 → 不命中
      if (kind !== "number" || typeof clause.value !== "number") return true;
      if (typeof v !== "number") return false;
      if (op === "gt") return v > clause.value;
      if (op === "gte") return v >= clause.value;
      if (op === "lt") return v < clause.value;
      return v <= clause.value;
    }
    case "in":
    case "notIn": {
      if (!arr || arr.length === 0) return true;
      if (kind !== "select" && kind !== "person" && kind !== "enum") return true;
      // notIn 语义 =「有值且不在列表」（无值走 isEmpty 口径）
      const present = v !== null && v !== undefined;
      if (op === "in") return present && arr.includes(v);
      return present && !arr.includes(v);
    }
    case "hasAny":
    case "hasAll": {
      if (!arr || arr.length === 0) return true;
      if (kind !== "multi") return true;
      if (!Array.isArray(v)) return false;
      const values = v as unknown[];
      const hitAny = values.some((x) => arr.includes(x));
      if (op === "hasAny") return hitAny;
      return arr.every((x) => values.includes(x));
    }
    case "is":
    case "before":
    case "after": {
      if (kind !== "date" || typeof clause.value !== "string") return true;
      if (isEmptyValue(v) || typeof v !== "string") return false;
      if (op === "is") return v === clause.value;
      if (op === "before") return v < clause.value;
      return v > clause.value;
    }
    case "isEmpty":
    case "isNotEmpty": {
      if (kind === "checkbox") return true; // checkbox 用 isTrue/isFalse
      const empty =
        isEmptyValue(v) || (kind === "multi" && Array.isArray(v) && v.length === 0);
      return op === "isEmpty" ? empty : !empty;
    }
    case "isTrue":
      return kind === "checkbox" && v === true;
    case "isFalse":
      return kind === "checkbox" ? v !== true : true;
    default:
      return true; // 未知 op：忽略子句
  }
}

/** 任务数据库筛选：所有子句取交集 */
export function applyDbFilters<T extends DbFilterableTask>(
  tasks: T[],
  clauses: DbFilterClause[],
  ctx: DbFilterContext,
): T[] {
  if (clauses.length === 0) return tasks;
  return tasks.filter((t) => clauses.every((c) => matchClause(t, c, ctx)));
}
