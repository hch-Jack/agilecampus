"use client";

// 任务数据库（只读总览表）的筛选条：条件写入 URL 的 dbf 参数（JSON 编码），
// 与看板筛选（assignee/priority/... 各自参数）共存于同一条 URL——更新时只动 dbf 键。
// 服务端 applyDbFilters 按 URL 过滤（刷新/分享保持），本组件只负责编辑与跳转。
import { useMemo } from "react";
import type { PropertyType } from "@/db/schema";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";
import { PRIORITY_TEXT, STATUS_TEXT } from "@/lib/task-constants";
import {
  DB_FILTER_PARAM,
  DB_OP_LABELS,
  dbFieldMeta,
  opsForDbKind,
  parseDbFilters,
  serializeDbFilters,
  type DbFilterClause,
  type DbFilterContext,
  type DbFilterOp,
} from "@/lib/task-database-filters";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

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

export function TaskDatabaseFilterBar({
  defs,
  members,
  milestones,
}: {
  defs: { id: string; name: string; type: string; options: { id: string; name: string; color: string }[] | null }[];
  members: { id: string; name: string }[];
  milestones: { id: string; title: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const clauses = useMemo(() => parseDbFilters(searchParams.get("dbf")), [searchParams]);

  const ctx = useMemo<DbFilterContext>(
    () => ({
      defs: new Map(
        defs.map((d) => [
          d.id,
          { type: d.type as PropertyType, optionIds: (d.options ?? []).map((o) => o.id) },
        ]),
      ),
      milestoneOrder: new Map(milestones.map((m, i) => [m.id, i])),
      members: new Map(members.map((m) => [m.id, m.name])),
    }),
    [defs, members, milestones],
  );

  function push(next: DbFilterClause[]) {
    const params = new URLSearchParams(searchParams.toString());
    const serialized = serializeDbFilters(next);
    if (serialized) params.set(DB_FILTER_PARAM, encodeURIComponent(serialized));
    else params.delete(DB_FILTER_PARAM);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const choicesFor = (field: string): Choice[] => {
    if (field === "status")
      return ["todo", "doing", "done"].map((s) => ({ id: s, name: STATUS_TEXT[s] ?? s }));
    if (field === "priority")
      return ["high", "medium", "low"].map((p) => ({ id: p, name: PRIORITY_TEXT[p] ?? p }));
    if (field === "assignee") return members.map((m) => ({ id: m.id, name: m.name }));
    if (field === "milestone") return milestones.map((m) => ({ id: m.id, name: m.title }));
    if (field === "label") return [];
    if (field.startsWith("prop:")) {
      const def = defs.find((d) => d.id === field.slice(5));
      if (!def) return [];
      if (def.type === "select" || def.type === "multi_select")
        return (def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color }));
      if (def.type === "person") return members.map((m) => ({ id: m.id, name: m.name }));
    }
    return [];
  };

  const fieldLabel = (field: string) =>
    field.startsWith("prop:")
      ? (defs.find((d) => d.id === field.slice(5))?.name ?? "已删属性")
      : (FIELD_LABELS[field] ?? field);

  const addFilter = (field: string) => {
    const meta = dbFieldMeta(field, ctx);
    if (!meta) return;
    const ops = opsForDbKind(meta.kind);
    const clause: DbFilterClause = { field, op: ops[0] };
    if (ops[0] === "in" || ops[0] === "hasAny") clause.value = [];
    push([...clauses, clause].slice(0, 10));
  };
  const patchClause = (index: number, patch: Partial<DbFilterClause>) => {
    push(clauses.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  function ValueEditor({ clause, onChange }: { clause: DbFilterClause; onChange(value: unknown): void }) {
    const meta = dbFieldMeta(clause.field, ctx);
    if (!meta) return null;
    const op = clause.op as DbFilterOp;
    const NO_VALUE: DbFilterOp[] = ["isEmpty", "isNotEmpty", "isTrue", "isFalse"];
    if (NO_VALUE.includes(op)) return null;

    const choices = choicesFor(clause.field);
    const selected = Array.isArray(clause.value) ? (clause.value as string[]) : [];
    const toggle = (id: string) =>
      onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

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
            {choices.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-ink-faint">暂无可选项</p>
            )}
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
                  <span className={`ac-badge px-1.5 py-0 text-[11px] ${LABEL_COLOR_CLASS[c.color] ?? ""}`}>
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
          onChange={(e) => onChange(e.target.value || undefined)}
          placeholder="关键字"
          className="ac-field w-28 px-1.5 py-0.5 text-xs"
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

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-line bg-sunken px-3 py-2 text-sm">
      <details className="relative">
        <summary className="ac-btn-ghost cursor-pointer list-none whitespace-nowrap px-2 py-0.5 text-xs">
          筛选{clauses.length > 0 && ` (${clauses.length})`} +
        </summary>
        <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-40 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
          {Object.entries(FIELD_LABELS).map(([field, label]) => (
            <button
              key={field}
              type="button"
              onClick={() => addFilter(field)}
              className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
            >
              {label}
            </button>
          ))}
          {defs.length > 0 && (
            <p className="mt-1 border-t border-line px-2 pt-1 text-[11px] text-ink-faint">自定义属性</p>
          )}
          {defs.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => addFilter(`prop:${d.id}`)}
              className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
            >
              {d.name}
            </button>
          ))}
        </div>
      </details>

      {clauses.map((clause, index) => {
        const meta = dbFieldMeta(clause.field, ctx);
        return (
          <span
            key={`${clause.field}:${clause.op}:${index}`}
            className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-line bg-surface px-1.5 py-0.5 text-xs"
          >
            <details className="relative">
              <summary className="cursor-pointer list-none whitespace-nowrap px-1 text-ink-soft hover:text-primary">
                {fieldLabel(clause.field)} ▾
              </summary>
              <div className="absolute left-0 top-full z-30 mt-1 max-h-72 w-40 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
                {Object.entries(FIELD_LABELS).map(([field, label]) => (
                  <button
                    key={field}
                    type="button"
                    onClick={() => patchClause(index, { field, op: opsForDbKind(dbFieldMeta(field, ctx)?.kind ?? "text")[0], value: undefined })}
                    className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
                  >
                    {label}
                  </button>
                ))}
                {defs.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() =>
                      patchClause(index, { field: `prop:${d.id}`, op: opsForDbKind(dbFieldMeta(`prop:${d.id}`, ctx)?.kind ?? "text")[0], value: undefined })
                    }
                    className="block w-full rounded px-2 py-1 text-left text-xs text-ink hover:bg-sunken"
                  >
                    {d.name}
                  </button>
                ))}
              </div>
            </details>
            {meta && (
              <select
                value={clause.op}
                onChange={(e) => patchClause(index, { op: e.target.value, value: undefined })}
                className="ac-field w-auto px-1.5 py-0.5 text-xs"
              >
                {opsForDbKind(meta.kind).map((op) => (
                  <option key={op} value={op}>
                    {DB_OP_LABELS[op]}
                  </option>
                ))}
              </select>
            )}
            <ValueEditor clause={clause} onChange={(value) => patchClause(index, { value })} />
            <button
              type="button"
              onClick={() => push(clauses.filter((_, i) => i !== index))}
              className="px-1 text-ink-faint hover:text-high"
              aria-label="删除筛选条件"
            >
              ×
            </button>
          </span>
        );
      })}
    </div>
  );
}
