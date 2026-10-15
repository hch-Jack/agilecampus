"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 草案卡片：助手拟的一切改动都先落在这些卡片上，用户改完点「确认落库」才生效。
 *
 * 两个 scope 共用本组件：
 * - **project**（项目页）：卡片里的项目就是页面那个，落库时把 projectId 一并送上去。
 * - **personal**（工作台）：一轮对话可能横跨好几个项目，故 projectId 由**草案自己**带着
 *   （工具 schema 强制要求），落库时由服务端从草案里拆出来重校权限。
 *
 * 下拉选项（成员/里程碑）经 `options` 按 projectId 查；查不到就空着 —— 选项只影响手感，
 * 权限与归属一律由落库那一关重校。
 */

export type Draft = { tool: string; draft: unknown };
type Option = { id: string; name: string };
export type OptionMap = Record<string, { members: Option[]; milestones: Option[] }>;
export type ChatScope = "project" | "personal";

const NO_OPTIONS = { members: [] as Option[], milestones: [] as Option[] };

async function commit(
  scope: ChatScope,
  defaultProjectId: string | undefined,
  tool: string,
  draft: unknown,
): Promise<string | null> {
  const res = await fetch("/api/chat/commit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      scope === "personal"
        ? { scope, tool, draft } // projectId 在 draft 里，由服务端拆
        : { scope, projectId: defaultProjectId, tool, draft },
    ),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return data.error ?? "落库失败";
  if (Array.isArray(data.conflicts) && data.conflicts.length > 0)
    return `有 ${data.conflicts.length} 项因他人改动未落库，请刷新后重试`;
  return null;
}

function CardShell({
  title,
  onConfirm,
  children,
}: {
  title: string;
  onConfirm: () => Promise<string | null>;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "pending" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);

  if (state === "done")
    return (
      <div className="ac-card p-2 text-xs text-done">
        {title}：已落库 ✓
      </div>
    );

  return (
    <div className="ac-card space-y-2 border-accent/30 bg-accent-soft p-2 text-sm">
      <p className="text-xs font-medium text-accent">待确认：{title}</p>
      {children}
      {err && <p className="text-xs text-high">{err}</p>}
      <button
        disabled={state === "pending"}
        onClick={async () => {
          setState("pending");
          setErr(null);
          const e = await onConfirm();
          if (e) {
            setErr(e);
            setState("idle");
          } else {
            setState("done");
            router.refresh();
          }
        }}
        className="ac-btn px-2 py-1 text-xs"
      >
        {state === "pending" ? "落库中…" : "确认落库"}
      </button>
    </div>
  );
}

export function DraftCards({
  drafts,
  options,
  defaultProjectId,
  scope,
}: {
  drafts: Draft[];
  options: OptionMap;
  defaultProjectId?: string;
  scope: ChatScope;
}) {
  return (
    <div className="mt-2 space-y-2">
      {drafts.map((d, i) => (
        <DraftCard
          key={i}
          draft={d}
          options={options}
          defaultProjectId={defaultProjectId}
          scope={scope}
        />
      ))}
    </div>
  );
}

function DraftCard({
  draft,
  options,
  defaultProjectId,
  scope,
}: {
  draft: Draft;
  options: OptionMap;
  defaultProjectId?: string;
  scope: ChatScope;
}) {
  const [data, setData] = useState<Record<string, unknown>>(draft.draft as Record<string, unknown>);

  // 个人 scope 的草案自带 projectId；项目页的草案没有，用页面那个兜底
  const pid = typeof data.projectId === "string" ? data.projectId : defaultProjectId;
  const opts = (pid ? options[pid] : undefined) ?? NO_OPTIONS;
  const save = (tool: string, payload: unknown) => commit(scope, defaultProjectId, tool, payload);

  if (draft.tool === "save_personal_context") {
    const d = data as { entries: { content: string; visibility?: string }[] };
    const setEntry = (idx: number, patch: object) =>
      setData({ ...d, entries: d.entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)) });
    return (
      <CardShell
        title={`记入我的上下文（${d.entries.length}）`}
        onConfirm={() => save("save_personal_context", d)}
      >
        {d.entries.map((e, idx) => (
          <div key={idx} className="flex flex-wrap gap-1 border-b border-line pb-1">
            <input
              value={e.content}
              onChange={(ev) => setEntry(idx, { content: ev.target.value })}
              className="ac-field flex-1 text-xs"
            />
            <select
              value={e.visibility ?? "shared"}
              onChange={(ev) => setEntry(idx, { visibility: ev.target.value })}
              className="ac-field w-auto text-xs"
            >
              <option value="shared">项目可见</option>
              <option value="private">仅自己</option>
            </select>
            <button
              type="button"
              onClick={() => setData({ ...d, entries: d.entries.filter((_, i) => i !== idx) })}
              className="text-xs text-high hover:underline"
            >
              删
            </button>
          </div>
        ))}
        <p className="text-xs text-ink-faint">
          「项目可见」会进项目助手，队友问起时助手可能提到它；「仅自己」只进你自己的工作台助手。
        </p>
      </CardShell>
    );
  }

  if (draft.tool === "create_project") {
    const d = data as { name?: string; description?: string; startDate?: string; endDate?: string };
    return (
      <CardShell title="创建项目" onConfirm={() => save("create_project", d)}>
        <input
          value={d.name ?? ""}
          onChange={(e) => setData({ ...d, name: e.target.value })}
          placeholder="项目名称"
          className="ac-field text-xs"
        />
        <textarea
          value={d.description ?? ""}
          onChange={(e) => setData({ ...d, description: e.target.value })}
          placeholder="描述"
          className="ac-field text-xs"
          rows={2}
        />
        <div className="flex gap-1">
          <input type="date" value={d.startDate ?? ""} onChange={(e) => setData({ ...d, startDate: e.target.value })} className="ac-field w-auto text-xs" />
          <input type="date" value={d.endDate ?? ""} onChange={(e) => setData({ ...d, endDate: e.target.value })} className="ac-field w-auto text-xs" />
        </div>
      </CardShell>
    );
  }

  if (draft.tool === "create_milestone") {
    const d = data as { title?: string; targetDate?: string };
    return (
      <CardShell title="创建里程碑" onConfirm={() => save("create_milestone", d)}>
        <input
          value={d.title ?? ""}
          onChange={(e) => setData({ ...d, title: e.target.value })}
          placeholder="里程碑名称"
          className="ac-field text-xs"
        />
        <input
          type="date"
          value={d.targetDate ?? ""}
          onChange={(e) => setData({ ...d, targetDate: e.target.value || undefined })}
          className="ac-field w-auto text-xs"
        />
      </CardShell>
    );
  }

  if (draft.tool === "decompose_tasks") {
    const d = data as {
      tasks: { title: string; assigneeId?: string; priority?: string; dueDate?: string; milestoneId?: string }[];
    };
    const setTask = (idx: number, patch: object) =>
      setData({ ...d, tasks: d.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });
    return (
      <CardShell title={`拆解任务（${d.tasks.length}）`} onConfirm={() => save("decompose_tasks", d)}>
        {d.tasks.map((t, idx) => (
          <div key={idx} className="flex flex-wrap gap-1 border-b border-line pb-1">
            <input value={t.title} onChange={(e) => setTask(idx, { title: e.target.value })} className="ac-field flex-1 text-xs" />
            <select value={t.assigneeId ?? ""} onChange={(e) => setTask(idx, { assigneeId: e.target.value || undefined })} className="ac-field w-auto text-xs">
              <option value="">未分配</option>
              {opts.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <select value={t.priority ?? "medium"} onChange={(e) => setTask(idx, { priority: e.target.value })} className="ac-field w-auto text-xs">
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
            <input type="date" value={t.dueDate ?? ""} onChange={(e) => setTask(idx, { dueDate: e.target.value || undefined })} className="ac-field w-auto text-xs" />
            <button type="button" onClick={() => setData({ ...d, tasks: d.tasks.filter((_, i) => i !== idx) })} className="text-xs text-high hover:underline">
              删
            </button>
          </div>
        ))}
      </CardShell>
    );
  }

  if (draft.tool === "update_tasks") {
    const d = data as { updates: { taskId: string; updatedAt: string; patch: Record<string, unknown> }[] };
    return (
      <CardShell title={`批量变更（${d.updates.length}）`} onConfirm={() => save("update_tasks", d)}>
        {d.updates.map((u, idx) => (
          <div key={idx} className="border-b border-line pb-1 text-xs">
            <span className="text-ink-soft">任务 {u.taskId.slice(0, 8)}…：</span>
            <span className="text-ink">{JSON.stringify(u.patch)}</span>
          </div>
        ))}
      </CardShell>
    );
  }

  if (draft.tool === "plan_sprint") {
    const d = data as { milestoneId: string; taskIds: string[]; dueDate: string };
    return (
      <CardShell title={`排期（${d.taskIds.length} 任务）`} onConfirm={() => save("plan_sprint", d)}>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <select value={d.milestoneId} onChange={(e) => setData({ ...d, milestoneId: e.target.value })} className="ac-field w-auto text-xs">
            {opts.milestones.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <input type="date" value={d.dueDate} onChange={(e) => setData({ ...d, dueDate: e.target.value })} className="ac-field w-auto text-xs" />
          <span className="text-ink-soft">{d.taskIds.length} 个任务</span>
        </div>
      </CardShell>
    );
  }

  return null;
}
