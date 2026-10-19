"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buildContinuationText, isContinuableTool } from "@/lib/agent/continuation";

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
// parentTaskId 只给依赖卡用：后置候选必须与前置任务同级
type Option = { id: string; name: string; parentTaskId?: string | null };
export type OptionMap = Record<string, { members: Option[]; milestones: Option[]; tasks: Option[] }>;
export type ChatScope = "project" | "personal";

const NO_OPTIONS = {
  members: [] as Option[],
  milestones: [] as Option[],
  tasks: [] as Option[],
};

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
  invalid,
  children,
}: {
  title: string;
  onConfirm: () => Promise<string | null>;
  /**
   * 这张卡还差什么才能落库（必填框空了、列表被删空了…）。有值就禁用「确认」并显出来 ——
   * 挡在点击之前，别让它走到落库口换回一句「草案格式无效」：那句话既没说是哪个框，
   * 用户还得自己猜哪儿不对。空/未给即视为没问题。
   */
  invalid?: string;
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
      {invalid && <p className="text-xs text-ink-soft">{invalid}</p>}
      <button
        disabled={state === "pending" || !!invalid}
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

// 必填校验：挑出第一处不对的地方（数组顺序即优先级），交给 CardShell 去禁用确认
function firstProblem(problems: (string | null)[]): string | undefined {
  return problems.find((p) => p !== null) ?? undefined;
}

export function DraftCards({
  drafts,
  options,
  defaultProjectId,
  scope,
  originalText = "",
  busy = false,
  onContinue,
}: {
  drafts: Draft[];
  options: OptionMap;
  defaultProjectId?: string;
  scope: ChatScope;
  /** 这一轮用户的原始请求，续做时复述给模型 */
  originalText?: string;
  /** 对话是否正在进行（续做按钮据此禁用） */
  busy?: boolean;
  /** 发送一条新消息；返回是否成功 */
  onContinue?: (text: string) => Promise<boolean>;
}) {
  // 已落库的卡片按序号记下**当前编辑后**的数据，供续做提示词复述
  const [committed, setCommitted] = useState<Map<number, Draft>>(new Map());
  const [continued, setContinued] = useState(false);

  const handleCommitted = (index: number, d: Draft) => {
    setCommitted((prev) => new Map(prev).set(index, d));
    // 之后再落库一张卡，就值得再问一次「还有后续吗」
    setContinued(false);
  };

  const canContinue =
    !!onContinue && [...committed.values()].some((d) => isContinuableTool(d.tool));

  return (
    <div className="mt-2 space-y-2">
      {drafts.map((d, i) => (
        <DraftCard
          key={i}
          index={i}
          draft={d}
          options={options}
          defaultProjectId={defaultProjectId}
          scope={scope}
          onCommitted={handleCommitted}
        />
      ))}
      {canContinue && !continued && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            if (!onContinue) return;
            setContinued(true);
            const remaining = drafts.filter((_, i) => !committed.has(i));
            const ok = await onContinue(
              buildContinuationText({
                originalText,
                committed: [...committed.values()],
                remaining,
              }),
            );
            // 失败（网络/接口）才把按钮放回来；成功就等新一屏草案
            if (!ok) setContinued(false);
          }}
          className="ac-btn-ghost px-2 py-1 text-xs"
        >
          继续处理后续动作
        </button>
      )}
    </div>
  );
}

// 批量变更卡片认得出来的字段。认不出的（模型将来加的新字段）照原样显示，不假装能改。
const PATCH_FIELDS: Record<
  string,
  {
    label: string;
    kind: "text" | "textarea" | "status" | "priority" | "member" | "milestone" | "date";
  }
> = {
  title: { label: "标题", kind: "text" },
  description: { label: "描述", kind: "textarea" },
  completionNote: { label: "完成说明", kind: "textarea" },
  status: { label: "状态", kind: "status" },
  assigneeId: { label: "负责人", kind: "member" },
  startDate: { label: "起始日", kind: "date" },
  dueDate: { label: "截止日", kind: "date" },
  milestoneId: { label: "里程碑", kind: "milestone" },
  priority: { label: "优先级", kind: "priority" },
};

const STATUS_TEXT: Record<string, string> = { todo: "待办", doing: "进行中", done: "已完成" };
const PRIORITY_TEXT: Record<string, string> = { low: "低", medium: "中", high: "高" };

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 选项来自响应里的 options（按草案的 projectId 查）——查不到就只显示 id，
// 不给一个空下拉：那样看着像「未分配」，确认下去却仍是原来那个人。
function IdOrSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Option[];
  onChange: (v: string) => void;
}) {
  if (options.length === 0) return <span className="text-ink">{value.slice(0, 8)}…</span>;
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="ac-field w-auto text-xs">
      {/* 原值不在选项里（模型臆造、或那人已退队）：显式列出来，否则下拉会一片空白 */}
      {!options.some((o) => o.id === value) && <option value={value}>{value.slice(0, 8)}…</option>}
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
    </select>
  );
}

function PatchField({
  field,
  value,
  members,
  milestones,
  onChange,
}: {
  field: string;
  value: unknown;
  members: Option[];
  milestones: Option[];
  onChange: (v: unknown) => void;
}) {
  const spec = PATCH_FIELDS[field];
  if (!spec) return <span className="text-ink-soft">{`${field}=${JSON.stringify(value)}`}</span>;
  const v = typeof value === "string" ? value : "";
  return (
    <label className="flex items-center gap-1">
      <span className="text-ink-soft">{spec.label}</span>
      {spec.kind === "text" && (
        <input value={v} onChange={(e) => onChange(e.target.value)} className="ac-field w-auto text-xs" />
      )}
      {spec.kind === "textarea" && (
        // 清空 = 送 null（落库层把 null 当「清空」、空串当「没给」）
        <textarea
          value={v}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          className="ac-field w-auto text-xs"
          rows={2}
        />
      )}
      {spec.kind === "date" && (
        // 清空 = 把这个日期**清掉**（送 null），不是「不改」：模型提的日期被用户删掉，
        // 意思显然是不想要它。落库口的 patchSchema 按 nullable 收，updateTask 也认这个语义。
        <input
          type="date"
          value={v}
          onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
          className="ac-field w-auto text-xs"
        />
      )}
      {spec.kind === "status" && (
        <select value={v} onChange={(e) => onChange(e.target.value)} className="ac-field w-auto text-xs">
          {Object.entries(STATUS_TEXT).map(([k, t]) => (
            <option key={k} value={k}>
              {t}
            </option>
          ))}
        </select>
      )}
      {spec.kind === "priority" && (
        <select value={v} onChange={(e) => onChange(e.target.value)} className="ac-field w-auto text-xs">
          {Object.entries(PRIORITY_TEXT).map(([k, t]) => (
            <option key={k} value={k}>
              {t}
            </option>
          ))}
        </select>
      )}
      {spec.kind === "member" && (
        <IdOrSelect value={v} options={members} onChange={(x) => onChange(x)} />
      )}
      {spec.kind === "milestone" && (
        <IdOrSelect value={v} options={milestones} onChange={(x) => onChange(x)} />
      )}
    </label>
  );
}

function DraftCard({
  index,
  draft,
  options,
  defaultProjectId,
  scope,
  onCommitted,
}: {
  index: number;
  draft: Draft;
  options: OptionMap;
  defaultProjectId?: string;
  scope: ChatScope;
  /** 落库成功后回调**当前编辑后**的数据，供「继续处理后续动作」复述 */
  onCommitted?: (index: number, d: Draft) => void;
}) {
  const [data, setData] = useState<Record<string, unknown>>(draft.draft as Record<string, unknown>);

  // 个人 scope 的草案自带 projectId；项目页的草案没有，用页面那个兜底
  const pid = typeof data.projectId === "string" ? data.projectId : defaultProjectId;
  const opts = (pid ? options[pid] : undefined) ?? NO_OPTIONS;
  const save = async (tool: string, payload: unknown) => {
    const err = await commit(scope, defaultProjectId, tool, payload);
    // 回调放在这里而不是 CardShell：拿到的才是用户改过之后的 payload
    if (!err) onCommitted?.(index, { tool, draft: payload });
    return err;
  };

  if (draft.tool === "save_personal_context") {
    const d = data as { entries: { content: string; visibility?: string }[] };
    const setEntry = (idx: number, patch: object) =>
      setData({ ...d, entries: d.entries.map((e, i) => (i === idx ? { ...e, ...patch } : e)) });
    const invalid = firstProblem([
      d.entries.length === 0 ? "没有要保存的条目" : null,
      d.entries.some((e) => e.content.trim() === "") ? "有条内容为空" : null,
    ]);
    return (
      <CardShell
        title={`记入我的上下文（${d.entries.length}）`}
        onConfirm={() => save("save_personal_context", d)}
        invalid={invalid}
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
    const invalid = firstProblem([
      (d.name ?? "").trim() === "" ? "项目名不能为空" : null,
      // 个人 scope 没有「当前团队」，teamId 只能由助手填在草案里；缺了就是它没填对
      scope === "personal" && typeof data.teamId !== "string"
        ? "草案里没带团队，请让助手重拟一次"
        : null,
    ]);
    return (
      <CardShell title="创建项目" onConfirm={() => save("create_project", d)} invalid={invalid}>
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
          {/* 可选日期：清空即「不设」，故送 undefined（空串会一路走到 date 列，PG 直接报错） */}
          <input type="date" value={d.startDate ?? ""} onChange={(e) => setData({ ...d, startDate: e.target.value || undefined })} className="ac-field w-auto text-xs" />
          <input type="date" value={d.endDate ?? ""} onChange={(e) => setData({ ...d, endDate: e.target.value || undefined })} className="ac-field w-auto text-xs" />
        </div>
      </CardShell>
    );
  }

  if (draft.tool === "create_milestone") {
    const d = data as { title?: string; targetDate?: string };
    return (
      <CardShell
        title="创建里程碑"
        onConfirm={() => save("create_milestone", d)}
        invalid={d.title?.trim() ? undefined : "里程碑名称不能为空"}
      >
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
      tasks: {
        title: string;
        assigneeId?: string;
        priority?: string;
        startDate?: string;
        dueDate?: string;
        milestoneId?: string;
      }[];
    };
    const setTask = (idx: number, patch: object) =>
      setData({ ...d, tasks: d.tasks.map((t, i) => (i === idx ? { ...t, ...patch } : t)) });
    const invalid = firstProblem([
      d.tasks.length === 0 ? "至少要留一个任务" : null,
      d.tasks.some((t) => t.title.trim() === "") ? "有条任务没写标题" : null,
    ]);
    return (
      <CardShell
        title={`拆解任务（${d.tasks.length}）`}
        onConfirm={() => save("decompose_tasks", d)}
        invalid={invalid}
      >
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
            <input
              type="date"
              aria-label="起始日"
              title="起始日"
              value={t.startDate ?? ""}
              onChange={(e) => setTask(idx, { startDate: e.target.value || undefined })}
              className="ac-field w-auto text-xs"
            />
            <input
              type="date"
              aria-label="截止日"
              title="截止日"
              value={t.dueDate ?? ""}
              onChange={(e) => setTask(idx, { dueDate: e.target.value || undefined })}
              className="ac-field w-auto text-xs"
            />
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
    const setPatch = (idx: number, patch: Record<string, unknown>) =>
      setData({
        ...d,
        updates: d.updates.map((u, i) => (i === idx ? { ...u, patch: { ...u.patch, ...patch } } : u)),
      });
    const invalid = firstProblem([
      d.updates.length === 0 ? "没有要改的任务" : null,
      d.updates.some((u) => u.patch.title !== undefined && String(u.patch.title).trim() === "")
        ? "有任务标题被清空了"
        : null,
    ]);
    return (
      <CardShell
        title={`批量变更（${d.updates.length}）`}
        onConfirm={() => save("update_tasks", d)}
        invalid={invalid}
      >
        {d.updates.map((u, idx) => (
          <div key={idx} className="flex flex-wrap items-center gap-2 border-b border-line pb-1 text-xs">
            <span className="text-ink-soft">任务 {u.taskId.slice(0, 8)}…</span>
            {Object.entries(u.patch).map(([field, value]) => (
              <PatchField
                key={field}
                field={field}
                value={value}
                members={opts.members}
                milestones={opts.milestones}
                onChange={(v) => setPatch(idx, { [field]: v })}
              />
            ))}
          </div>
        ))}
      </CardShell>
    );
  }

  if (draft.tool === "edit_task_links") {
    type Succ = { id: string; title: string; status: string; parentTaskId: string | null };
    const d = data as {
      predecessorId: string;
      predecessorTitle?: string;
      predecessorParentTaskId?: string | null;
      currentSuccessors?: Succ[];
      add?: string[];
      remove?: string[];
    };
    const current = d.currentSuccessors ?? [];
    const add = d.add ?? [];
    const remove = d.remove ?? [];
    const sameLevel = d.predecessorParentTaskId ?? null;
    const levelOf = (id: string) =>
      opts.tasks.find((t) => t.id === id)?.parentTaskId ?? null;
    const toggle = (key: "add" | "remove", id: string) => {
      const list = key === "add" ? add : remove;
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      setData({ ...d, [key]: next });
    };
    // 候选：同级的项目任务，排除前置自身，排除已经是后置的（除非正被移除）
    const candidate = opts.tasks.filter(
      (t) =>
        t.id !== d.predecessorId &&
        (t.parentTaskId ?? null) === sameLevel &&
        !current.some((s) => s.id === t.id) &&
        !add.includes(t.id),
    );
    const nameOf = (id: string) =>
      opts.tasks.find((t) => t.id === id)?.name ??
      current.find((s) => s.id === id)?.title ??
      `${id.slice(0, 8)}…`;
    // 有选项才校验同级：个人 scope 的选项可能没算出来，此时别把可用的草案误判为无效
    const levelKnown = opts.tasks.length > 0;
    const invalid = firstProblem([
      add.length + remove.length === 0 ? "请至少新增或移除一个后置任务" : null,
      add.some((id) => remove.includes(id)) ? "同一任务不能既新增又移除" : null,
      levelKnown && add.some((id) => levelOf(id) !== sameLevel)
        ? "只能连接与前置任务同级的任务"
        : null,
    ]);
    return (
      <CardShell
        title={`调整后置任务（${d.predecessorTitle ?? "前置任务"}）`}
        onConfirm={() => save("edit_task_links", d)}
        invalid={invalid}
      >
        <p className="text-xs text-ink-soft">
          前置任务：{d.predecessorTitle ?? `${d.predecessorId.slice(0, 8)}…`}
          。确认后按当前库里的最新状态增删，未提到的旧后置不会被动。
        </p>

        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-ink-soft">现有后置：</span>
          {current.length === 0 && <span className="text-ink-faint">无</span>}
          {current.map((s) => {
            const crossLevel = (s.parentTaskId ?? null) !== sameLevel;
            const removed = remove.includes(s.id);
            return (
              <span key={s.id} className="flex items-center gap-1 rounded border border-line px-1">
                <span className={removed ? "text-ink-faint line-through" : "text-ink"}>{s.title}</span>
                {/* 历史跨层级边只读：删它会静默无效，故不给按钮，标出来即可 */}
                {crossLevel ? (
                  <span className="text-ink-faint" title="历史跨层级依赖，当前不可调整">
                    跨层级·只读
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => toggle("remove", s.id)}
                    className="text-xs text-high hover:underline"
                  >
                    {removed ? "撤销" : "移除"}
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-ink-soft">新增后置：</span>
          {/* 已选的新增一律列成可撤销的 chip —— 包括模型给的非同级 id，
              否则同级校验会禁用确认，用户却找不到地方把它去掉 */}
          {add.length === 0 && candidate.length === 0 && (
            <span className="text-ink-faint">没有可选同级任务</span>
          )}
          {add.map((id) => (
            <span key={id} className="flex items-center gap-1 rounded border border-primary bg-primary-soft px-1 text-primary">
              {nameOf(id)}
              <button type="button" onClick={() => toggle("add", id)} className="text-high hover:underline">
                ×
              </button>
            </span>
          ))}
          {candidate.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => toggle("add", t.id)}
              className="rounded border border-line px-1 text-ink"
            >
              {t.name}
            </button>
          ))}
        </div>
      </CardShell>
    );
  }

  if (draft.tool === "plan_sprint") {
    const d = data as { milestoneId: string; taskIds: string[]; dueDate: string };
    // 截止日在这里是**必填**（排期就是定日子）：清空后不禁用，落库只会回一句报错
    const invalid = firstProblem([
      d.dueDate === "" ? "排期要给截止日" : null,
      d.taskIds.length === 0 ? "没有要排期的任务" : null,
    ]);
    return (
      <CardShell
        title={`排期（${d.taskIds.length} 任务）`}
        onConfirm={() => save("plan_sprint", d)}
        invalid={invalid}
      >
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <IdOrSelect
            value={d.milestoneId}
            options={opts.milestones}
            onChange={(v) => setData({ ...d, milestoneId: v })}
          />
          <input type="date" value={d.dueDate} onChange={(e) => setData({ ...d, dueDate: e.target.value })} className="ac-field w-auto text-xs" />
          <span className="text-ink-soft">{d.taskIds.length} 个任务</span>
        </div>
      </CardShell>
    );
  }

  if (draft.tool === "respond_group_invite") {
    const d = data as {
      inviteId?: string;
      accept?: boolean;
      groupName?: string;
      inviterName?: string;
    };
    const groupName = d.groupName?.trim() || "群聊";
    // 展示字段（群名/邀请人）只用来写标题，落库时被 zod 剥掉 —— 一切以邀请 id 为准
    const invalid = firstProblem([
      typeof d.inviteId !== "string" || d.inviteId === ""
        ? "草案缺少邀请 id，请让助手重拟"
        : null,
      typeof d.accept !== "boolean" ? "请选择接受或拒绝" : null,
    ]);
    return (
      <CardShell
        title={`群邀请（${groupName}）`}
        onConfirm={() => save("respond_group_invite", d)}
        invalid={invalid}
      >
        <p className="text-xs text-ink-soft">
          {groupName}
          {d.inviterName ? ` · ${d.inviterName} 邀请你进群` : " 的入群邀请"}
        </p>
        <div className="flex gap-1">
          {[
            { value: true, label: "接受" },
            { value: false, label: "拒绝" },
          ].map((opt) => (
            <button
              key={opt.label}
              type="button"
              aria-pressed={d.accept === opt.value}
              onClick={() => setData({ ...d, accept: opt.value })}
              className={`rounded border px-2 py-0.5 text-xs ${
                d.accept === opt.value
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-line text-ink-soft"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-ink-faint">
          确认后才真正处理。群已满等原因失败会如实报错，此时可改选「拒绝」再确认。
        </p>
      </CardShell>
    );
  }

  if (draft.tool === "send_message") {
    const d = data as {
      targetType?: "user" | "group";
      targetId?: string;
      targetName?: string;
      content?: string;
      fileSource?: "task" | "message" | null;
      attachmentId?: string | null;
      filename?: string | null;
      size?: number | null;
    };
    const hasAttachment = typeof d.attachmentId === "string" && d.attachmentId !== "";
    const invalid = firstProblem([
      typeof d.targetId !== "string" || d.targetId === ""
        ? "草案缺少发送对象，请让助手重拟"
        : null,
      (d.content ?? "").trim() === "" && !hasAttachment ? "消息内容和附件至少要有一个" : null,
    ]);
    return (
      <CardShell
        title={`发送消息（${d.targetName ?? "对方"}）`}
        onConfirm={() => save("send_message", d)}
        invalid={invalid}
      >
        <p className="text-xs text-ink-soft">
          发送给：{d.targetName ?? `${(d.targetId ?? "").slice(0, 8)}…`}
          （{d.targetType === "group" ? "群聊" : "私信"}）
        </p>
        <textarea
          value={d.content ?? ""}
          onChange={(e) => setData({ ...d, content: e.target.value })}
          placeholder="消息内容"
          className="ac-field text-xs"
          rows={3}
        />
        {hasAttachment && (
          <div className="flex flex-wrap items-center gap-1 text-xs text-ink-soft">
            <span>
              附件「{d.filename ?? "未命名文件"}」
              {typeof d.size === "number" ? `（${fmtSize(d.size)}）` : ""} · 来源：
              {d.fileSource === "task" ? "项目任务附件" : "消息附件"}
            </span>
            <button
              type="button"
              onClick={() =>
                setData({ ...d, fileSource: null, attachmentId: null, filename: null, size: null })
              }
              className="text-high hover:underline"
            >
              移除
            </button>
          </div>
        )}
        <p className="text-xs text-high">确认后立即发送，无法撤回。</p>
      </CardShell>
    );
  }

  if (draft.tool === "create_group_chat") {
    const d = data as {
      name?: string;
      memberIds?: string[];
      members?: { id: string; name: string }[];
    };
    const members = d.members ?? [];
    const memberCount = (d.memberIds ?? []).length + 1; // 包含群主自己
    const removeMember = (id: string) =>
      setData({
        ...d,
        memberIds: (d.memberIds ?? []).filter((x) => x !== id),
        members: members.filter((m) => m.id !== id),
      });
    const invalid = firstProblem([
      (d.name ?? "").trim() === "" ? "群名称不能为空" : null,
      (d.memberIds ?? []).length === 0 ? "至少需要一位成员" : null,
    ]);
    return (
      <CardShell
        title={`组建群聊（${d.name?.trim() || "新群"}）`}
        onConfirm={() => save("create_group_chat", d)}
        invalid={invalid}
      >
        <input
          value={d.name ?? ""}
          onChange={(e) => setData({ ...d, name: e.target.value })}
          placeholder="群聊名称"
          className="ac-field text-xs"
        />
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-ink-soft">成员（{memberCount} 人，含你）：</span>
          {members.length === 0 && <span className="text-ink-faint">无</span>}
          {members.map((m) => (
            <span
              key={m.id}
              className="flex items-center gap-1 rounded border border-line px-1 text-ink"
            >
              {m.name}
              <button
                type="button"
                onClick={() => removeMember(m.id)}
                className="text-high hover:underline"
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <p className="text-xs text-high">
          确认后立即建群，成员会被直接拉进群，无需对方同意；之后可在消息页继续邀请。
        </p>
      </CardShell>
    );
  }

  if (draft.tool === "forward_message") {
    const d = data as {
      sourceType?: "dm" | "group";
      sourceId?: string;
      messageId?: string;
      sourceLabel?: string;
      sourceSenderName?: string;
      content?: string;
      attachmentId?: string | null;
      filename?: string | null;
      size?: number | null;
      targetType?: "user" | "group";
      targetId?: string;
      targetName?: string;
    };
    const hasAttachment = typeof d.attachmentId === "string" && d.attachmentId !== "";
    const invalid = firstProblem([
      typeof d.sourceId !== "string" || d.sourceId === ""
        ? "草案缺少源会话，请让助手重拟"
        : null,
      typeof d.messageId !== "string" || d.messageId === ""
        ? "草案缺少源消息，请让助手重拟"
        : null,
      typeof d.targetId !== "string" || d.targetId === ""
        ? "草案缺少转发对象，请让助手重拟"
        : null,
      (d.content ?? "").trim() === "" && !hasAttachment ? "源消息没有可转发的内容" : null,
    ]);
    return (
      <CardShell
        title={`转发消息（${d.targetName ?? "对方"}）`}
        onConfirm={() => save("forward_message", d)}
        invalid={invalid}
      >
        <p className="text-xs text-ink-soft">
          来源：{d.sourceLabel ?? (d.sourceType === "group" ? "群聊" : "私信")}
          {d.sourceSenderName ? ` · ${d.sourceSenderName}` : ""}
        </p>
        {(d.content ?? "").trim() !== "" && (
          <p className="whitespace-pre-wrap break-words rounded border border-line bg-surface p-1 text-xs text-ink">
            {d.content}
          </p>
        )}
        {hasAttachment && (
          <p className="text-xs text-ink-soft">
            附件「{d.filename ?? "未命名文件"}」
            {typeof d.size === "number" ? `（${fmtSize(d.size)}）` : ""}
          </p>
        )}
        <p className="text-xs text-ink-soft">
          转发给：{d.targetName ?? `${(d.targetId ?? "").slice(0, 8)}…`}
          （{d.targetType === "group" ? "群聊" : "私信"}）
        </p>
        <p className="text-xs text-high">确认后会把原文与附件原样转发，无法撤回。</p>
      </CardShell>
    );
  }

  if (draft.tool === "create_subtask") {
    const d = data as {
      parentTaskId?: string;
      parentTitle?: string;
      title?: string;
      description?: string;
      assigneeId?: string;
      priority?: string;
      startDate?: string;
      dueDate?: string;
      milestoneId?: string;
    };
    const invalid = firstProblem([
      typeof d.parentTaskId !== "string" || d.parentTaskId === ""
        ? "草案缺少父任务，请让助手重拟"
        : null,
      (d.title ?? "").trim() === "" ? "子任务标题不能为空" : null,
    ]);
    return (
      <CardShell
        title={`新增子任务（${d.parentTitle ?? "父任务"}）`}
        onConfirm={() => save("create_subtask", d)}
        invalid={invalid}
      >
        <p className="text-xs text-ink-soft">
          父任务：{d.parentTitle ?? `${(d.parentTaskId ?? "").slice(0, 8)}…`}
        </p>
        <input
          value={d.title ?? ""}
          onChange={(e) => setData({ ...d, title: e.target.value })}
          placeholder="子任务标题"
          className="ac-field text-xs"
        />
        <textarea
          value={d.description ?? ""}
          onChange={(e) => setData({ ...d, description: e.target.value || undefined })}
          placeholder="描述（可选）"
          className="ac-field text-xs"
          rows={2}
        />
        <div className="flex flex-wrap gap-1">
          <select
            value={d.assigneeId ?? ""}
            onChange={(e) => setData({ ...d, assigneeId: e.target.value || undefined })}
            className="ac-field w-auto text-xs"
          >
            <option value="">未分配</option>
            {opts.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select
            value={d.priority ?? "medium"}
            onChange={(e) => setData({ ...d, priority: e.target.value })}
            className="ac-field w-auto text-xs"
          >
            {Object.entries(PRIORITY_TEXT).map(([k, t]) => (
              <option key={k} value={k}>
                {t}
              </option>
            ))}
          </select>
          <input
            type="date"
            aria-label="起始日"
            title="起始日"
            value={d.startDate ?? ""}
            onChange={(e) => setData({ ...d, startDate: e.target.value || undefined })}
            className="ac-field w-auto text-xs"
          />
          <input
            type="date"
            aria-label="截止日"
            title="截止日"
            value={d.dueDate ?? ""}
            onChange={(e) => setData({ ...d, dueDate: e.target.value || undefined })}
            className="ac-field w-auto text-xs"
          />
        </div>
      </CardShell>
    );
  }

  if (draft.tool === "delete_subtask") {
    const d = data as { taskId?: string; title?: string; parentTitle?: string };
    return (
      <CardShell
        title="删除子任务"
        onConfirm={() => save("delete_subtask", d)}
        invalid={
          typeof d.taskId !== "string" || d.taskId === ""
            ? "草案缺少任务 id，请让助手重拟"
            : undefined
        }
      >
        <p className="text-xs text-ink-soft">
          将删除子任务「{d.title ?? `${(d.taskId ?? "").slice(0, 8)}…`}」
          {d.parentTitle ? `（父任务：${d.parentTitle}）` : ""}。
        </p>
        <p className="text-xs text-high">它下面的所有子任务与依赖会一并删除，且不可恢复。</p>
      </CardShell>
    );
  }

  if (draft.tool === "delete_attachment") {
    const d = data as { attachmentId?: string; filename?: string; taskTitle?: string };
    return (
      <CardShell
        title="删除附件"
        onConfirm={() => save("delete_attachment", d)}
        invalid={
          typeof d.attachmentId !== "string" || d.attachmentId === ""
            ? "草案缺少附件 id，请让助手重拟"
            : undefined
        }
      >
        <p className="text-xs text-ink-soft">
          将删除任务{d.taskTitle ? `「${d.taskTitle}」` : ""}的附件「
          {d.filename ?? "未命名文件"}」，文件不可恢复。
        </p>
      </CardShell>
    );
  }

  if (draft.tool === "attach_message_file_to_task") {
    const d = data as {
      attachmentId?: string;
      taskId?: string;
      filename?: string;
      size?: number;
      taskTitle?: string;
    };
    const missingIds =
      typeof d.attachmentId !== "string" ||
      d.attachmentId === "" ||
      typeof d.taskId !== "string" ||
      d.taskId === "";
    return (
      <CardShell
        title="消息文件添加为任务附件"
        onConfirm={() => save("attach_message_file_to_task", d)}
        invalid={missingIds ? "草案缺少文件或任务 id，请让助手重拟" : undefined}
      >
        <p className="text-xs text-ink-soft">
          文件「{d.filename ?? "未命名文件"}」
          {typeof d.size === "number" ? `（${fmtSize(d.size)}）` : ""} → 任务
          {d.taskTitle ? `「${d.taskTitle}」` : "附件"}。
        </p>
        <p className="text-xs text-ink-faint">
          确认后会复制一份文件到任务附件；之后删除消息不会影响它。
        </p>
      </CardShell>
    );
  }

  return null;
}
