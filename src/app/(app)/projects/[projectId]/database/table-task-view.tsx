"use client";

// 任务数据库的表格视图（PR2b）：PR2a 的展示/列显隐/筛选排序 + 全单元格行内编辑。
// - 原生字段走 updateTaskFields / patchStatus（状态保留审批语义：学生置 done 且
//   requireApproval → 弹 CompletionRequestModal，与看板拖拽同一体验）
// - 自定义属性走 setTaskProps（键级合并，方案 D5）
// - 列头：自定义属性带 ⋯ 管理菜单（改名/选项/排序/删除），工具行有「＋属性」
// - 子任务保持只读缩进行（方案 §8，编辑走详情页）
import { useMemo, useState } from "react";
import Link from "next/link";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";
import { PRIORITY_BADGE, STATUS_BADGE, STATUS_TEXT, PRIORITY_TEXT } from "@/lib/task-constants";
import { applyViewFilters, applyViewSorts } from "@/lib/board-filters";
import type { FieldKey, TaskViewConfig } from "@/lib/database-views";
import type { PropertyOption } from "@/db/schema";
import { CompletionRequestModal } from "@/components/completion-request-modal";
import {
  ClickToEdit,
  TextEditor,
  NumberEditor,
  DateEditor,
  CheckboxEditor,
  ChoicesEditor,
  MultiChoicesEditor,
} from "./cell-editors";
import { AddPropertyButton, PropertyColumnMenu } from "./property-menu";
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

/** 自定义属性单元格展示（编辑态由 TaskCell 统一接管） */
function PropDisplay({ defId, value }: { defId: string; value: unknown }) {
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
      return value === true ? (
        <span className="text-xs">☑</span>
      ) : (
        <span className="text-xs text-ink-faint">—</span>
      );
    default:
      return <span className="text-xs text-ink-faint">—</span>;
  }
}

export function TableTaskView({
  config,
  onChangeConfig,
}: {
  config: TaskViewConfig;
  onChangeConfig(next: TaskViewConfig): void;
}) {
  const store = useTaskDatabase();
  const { tasks, defs, members, milestones, labels, canWrite, viewerRole } = store;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  // 学生把 requireApproval 任务置 done → 不直接提交，弹完成申请（与看板拖拽同一流程）
  const [completionTask, setCompletionTask] = useState<{ id: string; title: string } | null>(null);

  const ctx = useMemo(() => buildFilterContext(store), [store]);
  const milestoneName = useMemo(() => new Map(milestones.map((m) => [m.id, m.title])), [milestones]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);

  const statusChoices = useMemo(
    () => (["todo", "doing", "done"] as const).map((s) => ({ id: s, name: STATUS_TEXT[s] ?? s })),
    [],
  );
  const priorityChoices = useMemo(
    () => (["high", "medium", "low"] as const).map((p) => ({ id: p, name: PRIORITY_TEXT[p] ?? p })),
    [],
  );
  const memberChoices = useMemo(() => members.map((m) => ({ id: m.id, name: m.name })), [members]);
  const milestoneChoices = useMemo(
    () => milestones.map((m) => ({ id: m.id, name: m.title })),
    [milestones],
  );
  const labelChoices = useMemo(() => labels.map((l) => ({ id: l.id, name: l.name, color: l.color })), [labels]);

  const topLevel = useMemo(() => tasks.filter((t) => !t.parentTaskId), [tasks]);
  const rows = useMemo(
    () =>
      applyViewSorts(
        applyViewFilters(topLevel, config.filters ?? [], ctx),
        config.sorts ?? [],
        ctx,
      ),
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

  /** 状态提交：学生 + 需审批 + 置 done → 弹完成申请；其余直接 patchStatus */
  function commitStatus(task: { id: string; title: string; status: string; requireApproval: boolean }, target: string | null) {
    if (!target || target === task.status) return;
    if (
      target === "done" &&
      task.status !== "done" &&
      viewerRole === "student" &&
      task.requireApproval
    ) {
      setCompletionTask({ id: task.id, title: task.title });
      return;
    }
    void store.patchStatus(task.id, target as "todo" | "doing" | "done");
  }

  /** 原生字段单元格（编辑态由 ClickToEdit 壳管理） */
  function NativeCell({ task, column }: { task: (typeof rows)[number]; column: FieldKey }) {
    switch (column) {
      case "status":
        return (
          <ClickToEdit
            canEdit={canWrite}
            className="w-fit"
            display={
              <span className={`ac-badge ${STATUS_BADGE[task.status]}`}>{STATUS_TEXT[task.status]}</span>
            }
            onCommit={(v) => commitStatus(task, typeof v === "string" ? v : null)}
            renderEditor={(commit, close) => (
              <ChoicesEditor
                choices={statusChoices}
                selected={task.status}
                onSubmit={(v) => commit(v)}
                onClose={close}
              />
            )}
          />
        );
      case "priority":
        return (
          <ClickToEdit
            canEdit={canWrite}
            className="w-fit"
            display={
              <span className={`ac-badge ${PRIORITY_BADGE[task.priority]}`}>
                {PRIORITY_TEXT[task.priority]}
              </span>
            }
            onCommit={(v) => void store.updateTaskFields(task.id, { priority: (v as "low" | "medium" | "high" | null) ?? undefined })}
            renderEditor={(commit, close) => (
              <ChoicesEditor
                choices={priorityChoices}
                selected={task.priority}
                allowClear={false}
                onSubmit={(v) => commit(v)}
                onClose={close}
              />
            )}
          />
        );
      case "assignee":
        return (
          <ClickToEdit
            canEdit={canWrite}
            className="max-w-full"
            display={<span className="truncate text-xs text-ink-soft">{task.assigneeName ?? "—"}</span>}
            onCommit={(v) => void store.updateTaskFields(task.id, { assigneeId: (v as string | null) ?? null })}
            renderEditor={(commit, close) => (
              <ChoicesEditor
                choices={memberChoices}
                selected={task.assigneeId}
                onSubmit={(v) => commit(v)}
                onClose={close}
              />
            )}
          />
        );
      case "milestone":
        return (
          <ClickToEdit
            canEdit={canWrite}
            className="max-w-full"
            display={
              <span className="truncate text-xs text-ink-soft">
                {task.milestoneId ? (milestoneName.get(task.milestoneId) ?? "—") : "—"}
              </span>
            }
            onCommit={(v) => void store.updateTaskFields(task.id, { milestoneId: (v as string | null) ?? null })}
            renderEditor={(commit, close) => (
              <ChoicesEditor
                choices={milestoneChoices}
                selected={task.milestoneId}
                onSubmit={(v) => commit(v)}
                onClose={close}
              />
            )}
          />
        );
      case "startDate":
      case "dueDate": {
        const key = column as "startDate" | "dueDate";
        return (
          <ClickToEdit
            canEdit={canWrite}
            display={<span className="text-xs text-ink-soft">{task[key] ?? "—"}</span>}
            onCommit={(v) => void store.updateTaskFields(task.id, { [key]: (v as string | null) ?? null })}
            renderEditor={(commit, close) => (
              <DateEditor
                initial={task[key]}
                onSubmit={(v) => commit(v)}
                onClose={close}
              />
            )}
          />
        );
      }
      case "label": {
        const chips = task.labels
          .map((l) => labelById.get(l.id))
          .filter((l): l is NonNullable<typeof l> => !!l);
        return (
          <ClickToEdit
            canEdit={canWrite}
            className="max-w-full"
            display={
              chips.length === 0 ? (
                <span className="text-xs text-ink-faint">—</span>
              ) : (
                <span className="flex flex-wrap gap-1">
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
              )
            }
            onCommit={(v) => void store.updateTaskFields(task.id, { labelIds: (v as string[]) ?? [] })}
            renderEditor={(commit, close) => (
              <MultiChoicesEditor
                choices={labelChoices}
                selected={task.labels.map((l) => l.id)}
                onSubmit={(ids) => commit(ids)}
                onClose={close}
              />
            )}
          />
        );
      }
      default:
        return null;
    }
  }

  /** 自定义属性单元格 */
  function PropCell({ task, defId }: { task: (typeof rows)[number]; defId: string }) {
    const def = defs.find((d) => d.id === defId);
    if (!def) return <span className="text-xs text-ink-faint">—</span>;
    const value = task.properties?.[defId];

    if (def.type === "checkbox") {
      // checkbox 无编辑态：即点即存
      return (
        <span className="flex items-center">
          <CheckboxEditor
            checked={value === true}
            onToggle={() => void store.setTaskProps(task.id, { [defId]: value === true ? null : true })}
          />
        </span>
      );
    }

    return (
      <ClickToEdit
        canEdit={canWrite}
        className="max-w-full"
        display={<PropDisplay defId={defId} value={value} />}
        onCommit={(v) => void store.setTaskProps(task.id, { [defId]: v })}
        renderEditor={(commit, close) => {
          switch (def.type) {
            case "text":
              return (
                <TextEditor
                  initial={typeof value === "string" ? value : ""}
                  onSubmit={(v) => commit(v)}
                  onClose={close}
                />
              );
            case "number":
              return (
                <NumberEditor
                  initial={typeof value === "number" ? value : null}
                  onSubmit={(v) => commit(v)}
                  onClose={close}
                />
              );
            case "select":
              return (
                <ChoicesEditor
                  choices={(def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color }))}
                  selected={typeof value === "string" ? value : null}
                  onSubmit={(v) => commit(v)}
                  onClose={close}
                />
              );
            case "multi_select":
              return (
                <MultiChoicesEditor
                  choices={(def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color }))}
                  selected={Array.isArray(value) ? value.map(String) : []}
                  onSubmit={(ids) => commit(ids.length ? ids : null)}
                  onClose={close}
                />
              );
            case "date":
              return (
                <DateEditor
                  initial={typeof value === "string" ? value : null}
                  onSubmit={(v) => commit(v)}
                  onClose={close}
                />
              );
            case "person":
              return (
                <ChoicesEditor
                  choices={memberChoices}
                  selected={typeof value === "string" ? value : null}
                  onSubmit={(v) => commit(v)}
                  onClose={close}
                />
              );
            default:
              return null;
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-xs text-ink-faint">
          {rows.length === total ? `共 ${total} 个任务` : `筛选后 ${rows.length} / ${total} 个任务`}
        </span>
        {canWrite && <AddPropertyButton />}
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
                <span key={d.id} className="flex min-w-0 items-center gap-0.5">
                  <span className="min-w-0 truncate">{d.name}</span>
                  <PropertyColumnMenu def={d} />
                </span>
              ))}
            </div>
            {rows.map((task) => {
              const subs = subtasksByParent.get(task.id) ?? [];
              const open = expanded.has(task.id);
              return (
                <div key={task.id} className="border-b border-line last:border-b-0">
                  <div
                    className="grid items-start gap-2 px-3 py-2 text-sm transition-colors hover:bg-sunken"
                    style={{ gridTemplateColumns: gridCols }}
                  >
                    <div className="flex min-w-0 items-center gap-1.5 py-1">
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
                      <ClickToEdit
                        canEdit={canWrite}
                        className="min-w-0 flex-1"
                        display={
                          <Link
                            href={`/projects/${store.projectId}/tasks/${task.id}`}
                            className="truncate text-ink hover:text-primary"
                            title={task.title}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {task.title}
                          </Link>
                        }
                        onCommit={(v) =>
                          typeof v === "string" && v && void store.updateTaskFields(task.id, { title: v })
                        }
                        renderEditor={(commit, close) => (
                          <TextEditor
                            initial={task.title}
                            multiline
                            onSubmit={(v) => commit(v)}
                            onClose={close}
                          />
                        )}
                      />
                    </div>
                    {visibleNative.map((c) => (
                      <div key={c.key} className="relative min-w-0 py-1">
                        <NativeCell task={task} column={c.key} />
                      </div>
                    ))}
                    {visibleProps.map((d) => (
                      <div key={d.id} className="relative min-w-0 py-1">
                        <PropCell task={task} defId={d.id} />
                      </div>
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
                          <PropDisplay key={d.id} defId={d.id} value={sub.properties?.[d.id]} />
                        ))}
                      </div>
                    ))}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {completionTask && (
        <CompletionRequestModal
          taskId={completionTask.id}
          projectId={store.projectId}
          taskTitle={completionTask.title}
          onClose={() => setCompletionTask(null)}
        />
      )}
    </div>
  );
}
