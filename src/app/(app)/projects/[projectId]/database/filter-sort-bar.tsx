"use client";

// 任务数据库视图的筛选/排序编辑条（方案 PR2a 核心）。
// 条件以 FilterClause[] 存进视图 config（共享持久化），执行在前端内存（applyViewFilters）。
// 值编辑器按字段类型分派：文本/数字/日期直接输入，枚举类用勾选弹层，checkbox 无值。
import { useMemo } from "react";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";
import { PRIORITY_TEXT, STATUS_TEXT } from "@/lib/task-constants";
import {
  FILTER_OP_LABELS,
  opsForKind,
  viewFieldMeta,
  type ViewFilterContext,
  type ViewFilterOp,
} from "@/lib/board-filters";
import type { FieldKey, FilterClause, TaskViewConfig } from "@/lib/database-views";
import { useTaskDatabase } from "./database-store";

const FIELD_LABELS: Record<string, string> = {
  title: "任务",
  status: "状态",
  priority: "优先级",
  assignee: "负责人",
  milestone: "里程碑",
  label: "标签",
  startDate: "开始日",
  dueDate: "截止日",
};

type Choice = { id: string; name: string; color?: string };

export function fieldLabel(field: FieldKey, defs: { id: string; name: string }[]): string {
  if (field.startsWith("prop:")) {
    return defs.find((d) => d.id === field.slice(5))?.name ?? "已删属性";
  }
  return FIELD_LABELS[field] ?? field;
}

/** 组装纯函数层的筛选上下文（defs/members/milestoneOrder） */
export function buildFilterContext(store: {
  defs: { id: string; type: "text" | "number" | "select" | "multi_select" | "date" | "person" | "checkbox"; options: { id: string }[] | null }[];
  members: { id: string; name: string }[];
  milestones: { id: string }[];
}): ViewFilterContext {
  return {
    defs: new Map(
      store.defs.map((d) => [
        d.id,
        { type: d.type, optionIds: (d.options ?? []).map((o) => o.id) },
      ]),
    ),
    milestoneOrder: new Map(store.milestones.map((m, i) => [m.id, i])),
    members: new Map(store.members.map((m) => [m.id, m.name])),
  };
}

/** 字段的候选值列表（勾选弹层用）；空数组 = 自由输入型字段 */
function choicesFor(field: FieldKey, store: ReturnType<typeof useTaskDatabase>): Choice[] {
  if (field === "status")
    return ["todo", "doing", "done"].map((s) => ({ id: s, name: STATUS_TEXT[s] ?? s }));
  if (field === "priority")
    return ["high", "medium", "low"].map((p) => ({ id: p, name: PRIORITY_TEXT[p] ?? p }));
  if (field === "assignee") return store.members.map((m) => ({ id: m.id, name: m.name }));
  if (field === "milestone") return store.milestones.map((m) => ({ id: m.id, name: m.title }));
  if (field === "label") return store.labels.map((l) => ({ id: l.id, name: l.name, color: l.color }));
  if (field.startsWith("prop:")) {
    const def = store.defs.find((d) => d.id === field.slice(5));
    if (!def) return [];
    if (def.type === "select" || def.type === "multi_select")
      return (def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color }));
    if (def.type === "person") return store.members.map((m) => ({ id: m.id, name: m.name }));
  }
  return [];
}

function OpSelect({
  field,
  value,
  ctx,
  onChange,
}: {
  field: FieldKey;
  value: string;
  ctx: ViewFilterContext;
  onChange(op: string): void;
}) {
  const meta = viewFieldMeta(field, ctx);
  if (!meta) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ac-field w-auto px-1.5 py-0.5 text-xs"
    >
      {opsForKind(meta.kind).map((op) => (
        <option key={op} value={op}>
          {FILTER_OP_LABELS[op]}
        </option>
      ))}
    </select>
  );
}

/** 值编辑器：按字段类型分派。返回 null = 该操作符无值可编 */
function ValueEditor({
  clause,
  ctx,
  choices,
  onChange,
}: {
  clause: FilterClause;
  ctx: ViewFilterContext;
  choices: Choice[];
  onChange(value: unknown): void;
}) {
  const meta = viewFieldMeta(clause.field, ctx);
  if (!meta) return null;
  const op = clause.op as ViewFilterOp;
  const NO_VALUE: ViewFilterOp[] = ["isEmpty", "isNotEmpty", "isTrue", "isFalse"];
  if (NO_VALUE.includes(op)) return null;

  const selected = Array.isArray(clause.value) ? (clause.value as string[]) : [];
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  // 枚举/人员/里程碑/标签/自定义单选多选：勾选弹层
  if (
    meta.kind === "enum" ||
    meta.kind === "multi" ||
    (meta.kind === "select" && op !== "isEmpty" && op !== "isNotEmpty") ||
    (meta.kind === "person" && (op === "in" || op === "notIn"))
  ) {
    const label =
      selected.length === 0
        ? "选择…"
        : selected.length <= 2
          ? choices
              .filter((c) => selected.includes(c.id))
              .map((c) => c.name)
              .join("、")
          : `${selected.length} 项`;
    return (
      <details className="relative">
        <summary className="ac-btn-ghost cursor-pointer list-none whitespace-nowrap px-2 py-0.5 text-xs">
          {label}
        </summary>
        <div className="absolute left-0 top-full z-30 mt-1 max-h-64 w-44 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
          {choices.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-faint">暂无可选项</p>}
          {choices.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink hover:bg-sunken"
            >
              <input
                type="checkbox"
                checked={selected.includes(c.id)}
                onChange={() => toggle(c.id)}
                className="accent-primary"
              />
              {c.color && (
                <span
                  className={`ac-badge px-1.5 py-0 text-[11px] ${LABEL_COLOR_CLASS[c.color] ?? ""}`}
                >
                  {c.name}
                </span>
              )}
              {!c.color && <span className="truncate">{c.name}</span>}
            </label>
          ))}
        </div>
      </details>
    );
  }

  if (meta.kind === "text" && (op === "contains" || op === "notContains")) {
    return (
      <input
        value={typeof clause.value === "string" ? clause.value : ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder="输入关键字"
        className="ac-field w-32 px-1.5 py-0.5 text-xs"
      />
    );
  }
  if (meta.kind === "number") {
    return (
      <input
        type="number"
        value={typeof clause.value === "number" ? clause.value : ""}
        onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        className="ac-field w-20 px-1.5 py-0.5 text-xs"
      />
    );
  }
  if (meta.kind === "date") {
    return (
      <input
        type="date"
        value={typeof clause.value === "string" ? clause.value : ""}
        onChange={(e) => onChange(e.target.value || undefined)}
        className="ac-field px-1.5 py-0.5 text-xs"
      />
    );
  }
  return null;
}

export function FilterSortBar({
  config,
  onChange,
}: {
  config: TaskViewConfig;
  onChange(next: TaskViewConfig): void;
}) {
  const store = useTaskDatabase();
  const ctx = useMemo(() => buildFilterContext(store), [store]);
  const filters = config.filters ?? [];
  const sorts = config.sorts ?? [];

  const addFilter = (field: FieldKey) => {
    const meta = viewFieldMeta(field, ctx);
    if (!meta) return;
    const ops = opsForKind(meta.kind);
    const clause: FilterClause = { id: crypto.randomUUID(), field, op: ops[0] };
    // 默认操作符若需要值，给个初始形状，避免「添加后没反应」的观感
    if (ops[0] === "in" || ops[0] === "hasAny") clause.value = [];
    onChange({ ...config, filters: [...filters, clause].slice(0, 10) });
  };
  const patchFilter = (id: string, patch: Partial<FilterClause>) => {
    onChange({
      ...config,
      filters: filters.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    });
  };

  const addSort = (field: FieldKey) => {
    if (sorts.length >= 2) return;
    onChange({ ...config, sorts: [...sorts, { field, dir: "asc" }] });
  };

  const fields = (
    <>
      {Object.entries(FIELD_LABELS).map(([field, label]) => (
        <button
          key={field}
          type="button"
          onClick={() => addFilter(field as FieldKey)}
          className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
        >
          {label}
        </button>
      ))}
      {store.defs.length > 0 && (
        <p className="mt-1 border-t border-line px-2 pt-1 text-[11px] text-ink-faint">自定义属性</p>
      )}
      {store.defs.map((d) => (
        <button
          key={d.id}
          type="button"
          onClick={() => addFilter(`prop:${d.id}` as FieldKey)}
          className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
        >
          {d.name}
        </button>
      ))}
    </>
  );

  const sortFields = (
    <>
      {Object.entries(FIELD_LABELS).map(([field, label]) => (
        <button
          key={field}
          type="button"
          disabled={sorts.some((s) => s.field === field)}
          onClick={() => addSort(field as FieldKey)}
          className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken disabled:opacity-40"
        >
          {label}
        </button>
      ))}
      {store.defs.map((d) => (
        <button
          key={d.id}
          type="button"
          disabled={sorts.some((s) => s.field === `prop:${d.id}`)}
          onClick={() => addSort(`prop:${d.id}` as FieldKey)}
          className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken disabled:opacity-40"
        >
          {d.name}
        </button>
      ))}
    </>
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-sunken px-3 py-2 text-sm">
      {/* 筛选 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <details className="relative">
          <summary className="ac-btn-ghost cursor-pointer list-none whitespace-nowrap px-2 py-0.5 text-xs">
            筛选{filters.length > 0 && ` (${filters.length})`} +
          </summary>
          <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-40 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
            {fields}
          </div>
        </details>
        {filters.map((f) => (
          <span
            key={f.id}
            className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-1.5 py-0.5 text-xs"
          >
            <details className="relative">
              <summary className="cursor-pointer list-none whitespace-nowrap px-1 text-ink-soft hover:text-primary">
                {fieldLabel(f.field, store.defs)} ▾
              </summary>
              <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-40 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
                {Object.entries(FIELD_LABELS).map(([field, label]) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => patchFilter(f.id, { field: field as FieldKey, value: undefined })}
                    className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
                  >
                    {label}
                  </button>
                ))}
                {store.defs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() =>
                      patchFilter(f.id, { field: `prop:${d.id}` as FieldKey, value: undefined })
                    }
                    className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </details>
            <OpSelect
              field={f.field}
              value={f.op}
              ctx={ctx}
              onChange={(op) => patchFilter(f.id, { op, value: undefined })}
            />
            <ValueEditor
              clause={f}
              ctx={ctx}
              choices={choicesFor(f.field, store)}
              onChange={(value) => patchFilter(f.id, { value })}
            />
            <button
              type="button"
              onClick={() => onChange({ ...config, filters: filters.filter((x) => x.id !== f.id) })}
              className="px-1 text-ink-faint hover:text-high"
              aria-label="删除筛选条件"
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {/* 排序 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <details className="relative">
          <summary className="ac-btn-ghost cursor-pointer list-none whitespace-nowrap px-2 py-0.5 text-xs">
            排序{sorts.length > 0 && ` (${sorts.length})`} +
          </summary>
          <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-40 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
            {sortFields}
          </div>
        </details>
        {sorts.map((s, i) => (
          <span
            key={`${s.field}:${i}`}
            className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-1.5 py-0.5 text-xs"
          >
            <span className="whitespace-nowrap px-1 text-ink-soft">
              {fieldLabel(s.field, store.defs)}
            </span>
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...config,
                  sorts: sorts.map((x, j) =>
                    j === i ? { ...x, dir: x.dir === "asc" ? "desc" : "asc" } : x,
                  ),
                })
              }
              className="px-1 text-primary hover:underline"
            >
              {s.dir === "asc" ? "↑ 升序" : "↓ 降序"}
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...config, sorts: sorts.filter((_, j) => j !== i) })}
              className="px-1 text-ink-faint hover:text-high"
              aria-label="删除排序"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
