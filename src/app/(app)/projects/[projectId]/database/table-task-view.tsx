"use client";

// 任务数据库的表格视图（PR2a：展示 + 列显隐 + 全类型筛选/排序；行内编辑在 PR2b）。
// 数据来自 store（applyViewFilters/applyViewSorts 已按视图 config 过滤排序），
// 顶层任务行可展开只读的直接子任务缩进行；点任务名进详情页。
import { useMemo, useState } from "react";
import Link from "next/link";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";
import { PRIORITY_BADGE, STATUS_BADGE, STATUS_TEXT, PRIORITY_TEXT } from "@/lib/task-constants";
import { applyViewFilters, applyViewSorts } from "@/lib/board-filters";
import type { FieldKey, TaskViewConfig } from "@/lib/database-views";
import type { PropertyOption } from "@/db/schema";
import { buildFilterContext } from "./filter-sort-bar";
import { useTaskDatabase } from "./database-store";

const NATIVE_COLUMNS: { key: FieldKey; label: string }[] = [
  { key: "status", label: "状态" },
  { key: "priority", label: "优先级" },
  { key: "assignee", label: "负责人" },
  { key: "milestone", label: "里程碑" },
  { key: "startDate", label: "开始日" },
  { key: "dueDate", label: "截止日" },
  { key: "label", label: "标签" },
];

function OptionChip({ option }: { option: PropertyOption | undefined }) {
  if (!option) return <span className="text-xs text-ink-faint">未知选项</span>;
  return (
    <span className={`ac-badge px-1.5 py-0 text-[11px] ${LABEL_COLOR_CLASS[option.color] ?? ""}`}>
      {option.name}
    </span>
  );
}

/** 自定义属性单元格展示 */
function PropCell({ defId, value }: { defId: string; value: unknown }) {
  const { defs, members } = useTaskDatabase();
  const def = defs.find((d) => d.id === defId);
  if (!def) return <span className="text-xs text-ink-faint">—</span>;
  switch (def.type) {
    case "text":
      return <span className="truncate text-xs text-ink-soft">{typeof value === "string" && value ? value : "—"}</span>;
    case "number":
      return <span className="text-xs text-ink-soft">{typeof value === "number" ? value : "—"}</span>;
    case "select":
      return value ? (
        <OptionChip option={(def.options ?? []).find((o) => o.id === value)} />
      ) : (
        <span className="text-xs text-ink-faint">—</span>
      );
    case "multi_select": {
      const ids = Array.isArray(value) ? value : [];
      if (ids.length === 0) return <span className="text-xs text-ink-faint">—</span>;
      return (
        <span className="flex flex-wrap gap-1">
          {ids.map((id) => (
            <OptionChip key={String(id)} option={(def.options ?? []).find((o) => o.id === id)} />
          ))}
        </span>
      );
    }
    case "date":
      return <span className="text-xs text-ink-soft">{typeof value === "string" && value ? value : "—"}</span>;
    case "person": {
      const name = typeof value === "string" && value ? members.find((m) => m.id === value)?.name : null;
      return <span className="truncate text-xs text-ink-soft">{name ?? "—"}</span>;
    }
    case "checkbox":
      return <span className="text-xs">{value === true ? "☑" : <span className="text-ink-faint">—</span>}</span>;
    default:
      return <span className="text-xs text-ink-faint">—</span>;
  }
}

export function TableTaskView({ config, onChangeConfig }: { config: TaskViewConfig; onChangeConfig(next: TaskViewConfig): void }) {
  const store = useTaskDatabase();
  const { tasks, defs, milestones, labels } = store;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);

  const ctx = useMemo(() => buildFilterContext(store), [store]);
  const milestoneName = useMemo(() => new Map(milestones.map((m) => [m.id, m.title])), [milestones]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  // 表格只摆顶层任务；子任务作为展开行（只读，编辑走详情页——方案 §8）
  const topLevel = useMemo(() => tasks.filter((t) => !t.parentTaskId), [tasks]);
  const rows = useMemo(
    () => applyViewSorts(applyViewFilters(topLevel, config.filters ?? [], ctx), config.sorts ?? [], ctx),
    [topLevel, config.filters, config.sorts, ctx],
  );
  const subtasksByParent = useMemo(() => {
    const map = new Map<string, typeof tasks>();
    for (const t of tasks) {
      if (!t.parentTaskId) continue;
      const list = map.get(t.parentTaskId) ?? [];
      list.push(t);
      map.set(t.parentTaskId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return map;
  }, [tasks]);

  const hidden = config.hiddenColumns ?? [];
  const visibleProps = defs.filter((d) => !hidden.includes(`prop:${d.id}` as FieldKey));
  const visibleNative = NATIVE_COLUMNS.filter((c) => !hidden.includes(c.key));
  const toggleColumn = (key: FieldKey) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    onChangeConfig({ ...config, hiddenColumns: next });
  };

  const gridCols = `minmax(0, 2.4fr) ${[...visibleNative, ...visibleProps]
    .map(() => "minmax(96px, 1fr)")
    .join(" ")}`;
  const total = tasks.filter((t) => !t.parentTaskId).length;

  const toggleExpand = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-faint">
          {rows.length === total ? `共 ${total} 个任务` : `筛选后 ${rows.length} / ${total} 个任务`}
        </span>
        <details className="relative" open={columnsOpen}>
          <summary
            className="ac-btn-ghost cursor-pointer list-none px-2 py-0.5 text-xs"
            onClick={() => setColumnsOpen((o) => !o)}
          >
            列 ⚙
          </summary>
          <div className="absolute right-0 top-full z-30 mt-1 max-h-72 w-44 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg">
            {NATIVE_COLUMNS.map((c) => (
              <label
                key={c.key}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink hover:bg-sunken"
              >
                <input
                  type="checkbox"
                  checked={!hidden.includes(c.key)}
                  onChange={() => toggleColumn(c.key)}
                  className="accent-primary"
                />
                {c.label}
              </label>
            ))}
            {defs.length > 0 && (
              <p className="mt-1 border-t border-line px-2 pt-1 text-[11px] text-ink-faint">自定义属性</p>
            )}
            {defs.map((d) => (
              <label
                key={d.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink hover:bg-sunken"
              >
                <input
                  type="checkbox"
                  checked={!hidden.includes(`prop:${d.id}` as FieldKey)}
                  onChange={() => toggleColumn(`prop:${d.id}` as FieldKey)}
                  className="accent-primary"
                />
                {d.name}
              </label>
            ))}
          </div>
        </details>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-line px-4 py-6 text-sm text-ink-faint">
          {total === 0 ? "项目还没有任务，创建后这里会以数据库形式列出。" : "没有符合当前筛选条件的任务。"}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <div className="min-w-[760px]">
            <div
              className="grid items-center gap-2 border-b border-line bg-sunken/60 px-3 py-2 text-xs font-medium text-ink-faint"
              style={{ gridTemplateColumns: gridCols }}
            >
              <span>任务</span>
              {visibleNative.map((c) => (
                <span key={c.key}>{c.label}</span>
              ))}
              {visibleProps.map((d) => (
                <span key={d.id} className="truncate">
                  {d.name}
                </span>
              ))}
            </div>
            {rows.map((task) => {
              const subs = subtasksByParent.get(task.id) ?? [];
              const open = expanded.has(task.id);
              return (
                <div key={task.id} className="border-b border-line last:border-b-0">
                  <div
                    className="grid items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-sunken"
                    style={{ gridTemplateColumns: gridCols }}
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {subs.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => toggleExpand(task.id)}
                          className="shrink-0 text-xs text-ink-faint hover:text-primary"
                          aria-label={open ? "收起子任务" : "展开子任务"}
                        >
                          {open ? "▼" : "▸"}
                        </button>
                      ) : (
                        <span className="w-3 shrink-0" />
                      )}
                      <Link
                        href={`/projects/${store.projectId}/tasks/${task.id}`}
                        className="truncate text-ink hover:text-primary"
                        title={task.title}
                      >
                        {task.title}
                      </Link>
                    </div>
                    {visibleNative.map((c) => {
                      switch (c.key) {
                        case "status":
                          return (
                            <span key={c.key}>
                              <span className={`ac-badge ${STATUS_BADGE[task.status]}`}>
                                {STATUS_TEXT[task.status]}
                              </span>
                            </span>
                          );
                        case "priority":
                          return (
                            <span key={c.key}>
                              <span className={`ac-badge ${PRIORITY_BADGE[task.priority]}`}>
                                {PRIORITY_TEXT[task.priority]}
                              </span>
                            </span>
                          );
                        case "assignee":
                          return (
                            <span key={c.key} className="truncate text-xs text-ink-soft">
                              {task.assigneeName ?? "—"}
                            </span>
                          );
                        case "milestone":
                          return (
                            <span key={c.key} className="truncate text-xs text-ink-soft">
                              {task.milestoneId ? (milestoneName.get(task.milestoneId) ?? "—") : "—"}
                            </span>
                          );
                        case "startDate":
                          return (
                            <span key={c.key} className="text-xs text-ink-soft">
                              {task.startDate ?? "—"}
                            </span>
                          );
                        case "dueDate":
                          return (
                            <span key={c.key} className="text-xs text-ink-soft">
                              {task.dueDate ?? "—"}
                            </span>
                          );
                        case "label": {
                          const chips = task.labels
                            .map((l) => labelById.get(l.id))
                            .filter((l): l is NonNullable<typeof l> => !!l);
                          if (chips.length === 0)
                            return (
                              <span key={c.key} className="text-xs text-ink-faint">
                                —
                              </span>
                            );
                          return (
                            <span key={c.key} className="flex flex-wrap gap-1">
                              {chips.slice(0, 3).map((l) => (
                                <span
                                  key={l.id}
                                  className={`ac-badge px-1.5 py-0 text-[11px] ${LABEL_COLOR_CLASS[l.color] ?? ""}`}
                                >
                                  {l.name}
                                </span>
                              ))}
                              {chips.length > 3 && (
                                <span className="text-[11px] text-ink-faint">+{chips.length - 3}</span>
                              )}
                            </span>
                          );
                        }
                        default:
                          return null;
                      }
                    })}
                    {visibleProps.map((d) => (
                      <PropCell key={d.id} defId={d.id} value={task.properties?.[d.id]} />
                    ))}
                  </div>
                  {open &&
                    subs.map((sub) => (
                      <div
                        key={sub.id}
                        className="grid items-center gap-2 border-t border-line/60 bg-sunken/40 px-3 py-1.5 text-xs text-ink-soft"
                        style={{ gridTemplateColumns: gridCols }}
                      >
                        <span className="flex min-w-0 items-center gap-1.5 pl-6">
                          <span aria-hidden className="shrink-0 text-ink-faint">
                            └
                          </span>
                          <Link
                            href={`/projects/${store.projectId}/tasks/${sub.id}`}
                            className="truncate hover:text-primary"
                            title={sub.title}
                          >
                            {sub.title}
                          </Link>
                          <span className={`ac-badge shrink-0 ${STATUS_BADGE[sub.status]}`}>
                            {STATUS_TEXT[sub.status]}
                          </span>
                        </span>
                        {visibleNative.map((c) => (
                          <span key={c.key} className="truncate">
                            {c.key === "status"
                              ? ""
                              : c.key === "priority"
                                ? PRIORITY_TEXT[sub.priority]
                                : c.key === "assignee"
                                  ? (sub.assigneeName ?? "—")
                                  : c.key === "milestone"
                                    ? (sub.milestoneId ? (milestoneName.get(sub.milestoneId) ?? "—") : "—")
                                    : c.key === "startDate"
                                      ? (sub.startDate ?? "—")
                                      : c.key === "dueDate"
                                        ? (sub.dueDate ?? "—")
                                        : ""}
                          </span>
                        ))}
                        {visibleProps.map((d) => (
                          <PropCell key={d.id} defId={d.id} value={sub.properties?.[d.id]} />
                        ))}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
