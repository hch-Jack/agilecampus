// 看板筛选态 ↔ URL query 的纯函数模块。无 IO、不取系统时钟，
// 「今日」由调用方传入，便于单测。
import type { PropertyType, TaskPriority, TaskStatus } from "@/db/schema";
import type { FieldKey, FilterClause, SortClause } from "./database-views";
import { TASK_PRIORITIES, TASK_STATUSES } from "./task-constants";

export type GroupBy = "status" | "assignee" | "priority" | "milestone";

export type BoardFilters = {
  assignee: string[]; // uuid 或 "none"（未指派）
  priority: string[];
  label: string[]; // uuid
  milestone: string[]; // uuid 或 "none"（无里程碑）
  overdue: boolean;
  group: GroupBy;
};

export type FilterableTask = {
  assigneeId: string | null;
  priority: TaskPriority;
  milestoneId: string | null;
  dueDate: string | null;
  status: TaskStatus;
  labels: { id: string }[];
  /**
   * 有未决的完成申请时存在：任务状态仍是 todo/doing，但在看板上归入「待审批」列。
   * 纯派生字段，不落库。
   */
  pendingApproval?: { requestId: string; canDecide: boolean } | null;
};

const GROUPS: GroupBy[] = ["status", "assignee", "priority", "milestone"];
const PRIORITIES = ["low", "medium", "high"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EMPTY_FILTERS: BoardFilters = {
  assignee: [],
  priority: [],
  label: [],
  milestone: [],
  overdue: false,
  group: "status",
};

function idList(raw: string | null, allowNone: boolean): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s) || (allowNone && s === "none"));
}

export function parseFilters(params: URLSearchParams): BoardFilters {
  const group = params.get("group");
  return {
    assignee: idList(params.get("assignee"), true),
    priority: (params.get("priority") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => PRIORITIES.includes(s)),
    label: idList(params.get("label"), false),
    milestone: idList(params.get("milestone"), true),
    overdue: params.get("overdue") === "1",
    group: GROUPS.includes(group as GroupBy) ? (group as GroupBy) : "status",
  };
}

// 返回不含 "?" 的 query string；空筛选返回空串（URL 保持干净）
export function serializeFilters(f: BoardFilters): string {
  const p = new URLSearchParams();
  if (f.assignee.length) p.set("assignee", f.assignee.join(","));
  if (f.priority.length) p.set("priority", f.priority.join(","));
  if (f.label.length) p.set("label", f.label.join(","));
  if (f.milestone.length) p.set("milestone", f.milestone.join(","));
  if (f.overdue) p.set("overdue", "1");
  if (f.group !== "status") p.set("group", f.group);
  return p.toString();
}

export function applyFilters<T extends FilterableTask>(
  list: T[],
  f: BoardFilters,
  today: string,
): T[] {
  return list.filter((t) => {
    if (f.assignee.length && !f.assignee.includes(t.assigneeId ?? "none")) return false;
    if (f.priority.length && !f.priority.includes(t.priority)) return false;
    if (f.milestone.length && !f.milestone.includes(t.milestoneId ?? "none")) return false;
    if (f.label.length && !t.labels.some((l) => f.label.includes(l.id))) return false;
    if (f.overdue && !(t.dueDate && t.dueDate < today && t.status !== "done")) return false;
    return true;
  });
}

// ---------------------------------------------------------------- 任务数据库视图：筛选/排序
//
// 与上面的 URL 版筛选不同：条件属于视图 config（FilterClause/SortClause，结构收口在
// lib/database-views.ts，归一时已剔除失效字段引用），由前端内存执行（实验室规模，
// 方案 R7：SQL jsonb 下推后置）。本节仍是纯函数：op 非法/字段失效的子句整体忽略，
// 空值口径统一为「恒排最后、isEmpty 视为无值」。

export type ViewFilterContext = {
  /** `prop:<id>` 的属性定义（id → 类型与选项序）；引用已删属性的子句被忽略 */
  defs: Map<string, { type: PropertyType; optionIds: string[] }>;
  /** 里程碑序（milestoneId → 序号）：milestone 排序按项目里程碑顺序 */
  milestoneOrder: Map<string, number>;
  /** userId → 成员名：person（负责人/人员属性）排序按名字 */
  members: Map<string, string>;
};

/** 参与视图筛选/排序的任务形状（listProjectTasks 行天然满足） */
export type ViewFilterableTask = {
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
  sortOrder: number;
};

export type ViewFilterKind =
  | "text"
  | "number"
  | "select"
  | "multi"
  | "date"
  | "person"
  | "checkbox"
  | "enum";

export const FILTER_OP_LABELS = {
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
export type ViewFilterOp = keyof typeof FILTER_OP_LABELS;

const KIND_OPS: Record<ViewFilterKind, readonly ViewFilterOp[]> = {
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

/** 每个类型档位可用的操作符（筛选条 UI 与校验共用） */
export function opsForKind(kind: ViewFilterKind): readonly ViewFilterOp[] {
  return KIND_OPS[kind];
}

/**
 * 字段 → 取值器与类型档位。返回 null = 字段失效（引用已删属性/未知字段），
 * 调用方应忽略该子句。
 */
export function viewFieldMeta(
  field: FieldKey,
  ctx: ViewFilterContext,
): {
  kind: ViewFilterKind;
  /** 该字段的候选值 id 序（select/multi/enum 的选项；person/milestone 的成员/里程碑） */
  options?: string[];
  get: (t: ViewFilterableTask) => unknown;
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

/** 单条子句匹配。子句形状非法（op 与字段类型不配、值形状不对）→ 视为恒真（忽略子句） */
function matchClause(t: ViewFilterableTask, clause: FilterClause, ctx: ViewFilterContext): boolean {
  const meta = viewFieldMeta(clause.field, ctx);
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
      return true; // 未知 op（归一层会剥）：忽略子句
  }
}

/** 视图筛选：所有子句取交集 */
export function applyViewFilters<T extends ViewFilterableTask>(
  tasks: T[],
  filters: FilterClause[],
  ctx: ViewFilterContext,
): T[] {
  if (!filters.length) return tasks;
  return tasks.filter((t) => filters.every((c) => matchClause(t, c, ctx)));
}

/** 排序取值：null = 无值（恒排最后，与方向无关） */
function sortValueOf(
  t: ViewFilterableTask,
  meta: NonNullable<ReturnType<typeof viewFieldMeta>>,
  ctx: ViewFilterContext,
): string | number | null {
  const v = meta.get(t);
  switch (meta.kind) {
    case "text":
      return typeof v === "string" && v ? v : null;
    case "number":
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    case "select":
    case "enum": {
      if (v === null || v === undefined) return null;
      const idx = (meta.options ?? []).indexOf(String(v));
      return idx >= 0 ? idx : (meta.options?.length ?? 0);
    }
    case "multi": {
      const arr = Array.isArray(v) ? v : [];
      if (arr.length === 0) return null;
      const idx = (meta.options ?? []).indexOf(String(arr[0]));
      return idx >= 0 ? idx : (meta.options?.length ?? 0);
    }
    case "date":
      return typeof v === "string" && v ? v : null;
    case "person":
      return typeof v === "string" && v ? (ctx.members.get(v) ?? v) : null;
    case "checkbox":
      return v === true ? 1 : 0;
  }
}

/** 单字段比较器。milestone 特例：按项目里程碑顺序（无里程碑恒最后） */
function comparatorFor(
  sort: SortClause,
  ctx: ViewFilterContext,
): ((a: ViewFilterableTask, b: ViewFilterableTask) => number) | null {
  const meta = viewFieldMeta(sort.field, ctx);
  if (!meta) return null;
  const dir = sort.dir === "desc" ? -1 : 1;
  const isMilestone = sort.field === "milestone";
  return (a, b) => {
    let va: string | number | null;
    let vb: string | number | null;
    if (isMilestone) {
      const ma = a.milestoneId;
      const mb = b.milestoneId;
      va = ma ? (ctx.milestoneOrder.get(ma) ?? ctx.milestoneOrder.size) : null;
      vb = mb ? (ctx.milestoneOrder.get(mb) ?? ctx.milestoneOrder.size) : null;
    } else {
      va = sortValueOf(a, meta, ctx);
      vb = sortValueOf(b, meta, ctx);
    }
    if (va === null && vb === null) return 0;
    if (va === null) return 1; // 空值恒最后
    if (vb === null) return -1;
    const r =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb, "zh-Hans-CN")
        : (va as number) - (vb as number);
    return r * dir;
  };
}

/** 视图排序：依次按各子句比较（≤2 级，归一层已截断），稳定排序，平手回退 sortOrder 再 id */
export function applyViewSorts<T extends ViewFilterableTask>(
  tasks: T[],
  sorts: SortClause[],
  ctx: ViewFilterContext,
): T[] {
  const comparators = sorts
    .map((s) => comparatorFor(s, ctx))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  if (comparators.length === 0) return tasks;
  return [...tasks].sort((a, b) => {
    for (const cmp of comparators) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (a.id < b.id ? -1 : 1);
  });
}
