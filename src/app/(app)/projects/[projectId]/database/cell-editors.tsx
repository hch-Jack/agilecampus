"use client";

// 任务数据库行内编辑器（PR2b）。分两层：
// - 交互壳 ClickToEdit：点击单元格进入编辑态、提交后退出（表格用；详情页平铺不用壳）
// - 类型编辑器 Text/Number/Date/Checkbox/Choices/MultiChoices：内部持草稿态，
//   Enter/失焦/点选即提交（onSubmit(null) 表示清值）；Esc 取消。
// choices 由调用方构造（表格用 store、详情页用 props），编辑器不感知数据来源。

import { useState, type ReactNode } from "react";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";

export type Choice = { id: string; name: string; color?: string };

// ---------------------------------------------------------------- 交互壳

/**
 * 点击进入编辑态的单元格壳。display 为常态展示；renderEditor 在编辑态渲染，
 * 其 commit(value) 会先退出编辑态再回调 onCommit（乐观更新在调用方 store 里做）。
 */
export function ClickToEdit({
  canEdit,
  display,
  renderEditor,
  onCommit,
  className = "",
  editTitle = "点击编辑",
}: {
  canEdit: boolean;
  display: ReactNode;
  renderEditor: (commit: (value: unknown) => void, close: () => void) => ReactNode;
  onCommit: (value: unknown) => void;
  className?: string;
  editTitle?: string;
}) {
  const [editing, setEditing] = useState(false);
  if (!canEdit) return <div className={className}>{display}</div>;
  if (!editing)
    return (
      <div
        className={`${className} cursor-pointer rounded hover:bg-primary-soft/40`}
        onClick={() => setEditing(true)}
        title={editTitle}
      >
        {display}
      </div>
    );
  return (
    <div className={`${className} relative`}>
      {renderEditor(
        (value) => {
          setEditing(false);
          onCommit(value);
        },
        () => setEditing(false),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- 类型编辑器

/** 编辑器根：Popover（表格单元格内）或 Inline（详情页平铺），Esc 取消 */
function EditorShell({
  children,
  variant,
  onClose,
}: {
  children: ReactNode;
  variant: "popover" | "inline";
  onClose: () => void;
}) {
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className={
        variant === "popover"
          ? "absolute left-0 top-full z-40 mt-1 max-h-60 w-44 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
          : "rounded-lg border border-line bg-surface p-1"
      }
    >
      {children}
    </div>
  );
}

/** 文本：Enter 或失焦提交，空串 = 清值 */
export function TextEditor({
  initial,
  placeholder,
  multiline = false,
  onSubmit,
  onClose,
}: {
  initial: string;
  placeholder?: string;
  multiline?: boolean;
  onSubmit(value: string | null): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    const v = draft.trim();
    onSubmit(v === "" ? null : v);
  };
  const cls = "w-full rounded border border-primary bg-surface px-1.5 py-1 text-xs outline-none";
  if (multiline)
    return (
      <textarea
        autoFocus
        rows={3}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commit();
          }
          if (e.key === "Escape") onClose();
        }}
        onBlur={commit}
        className={cls}
      />
    );
  return (
    <input
      autoFocus
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onClose();
      }}
      onBlur={commit}
      className={cls}
    />
  );
}

/** 数字：Enter 或失焦提交，空 = 清值；非法输入维持草稿不提交 */
export function NumberEditor({
  initial,
  onSubmit,
  onClose,
}: {
  initial: number | null;
  onSubmit(value: number | null): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(initial === null ? "" : String(initial));
  const commit = () => {
    if (draft.trim() === "") return onSubmit(null);
    const n = Number(draft);
    if (!Number.isFinite(n)) return; // 非法数字不提交（服务端校验也会拦）
    onSubmit(n);
  };
  return (
    <input
      autoFocus
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") onClose();
      }}
      onBlur={commit}
      className="w-full rounded border border-primary bg-surface px-1.5 py-1 text-xs outline-none"
    />
  );
}

/** 日期：选择即提交，空 = 清值 */
export function DateEditor({
  initial,
  min,
  max,
  variant = "popover",
  onSubmit,
  onClose,
}: {
  initial: string | null;
  min?: string;
  max?: string;
  variant?: "popover" | "inline";
  onSubmit(value: string | null): void;
  onClose(): void;
}) {
  return (
    <input
      autoFocus
      type="date"
      value={initial ?? ""}
      min={min}
      max={max}
      onChange={(e) => onSubmit(e.target.value || null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className={
        variant === "popover"
          ? "w-40 rounded border border-primary bg-surface px-1.5 py-1 text-xs outline-none"
          : "rounded border border-primary bg-surface px-1.5 py-1 text-xs outline-none"
      }
    />
  );
}

/** checkbox：即点即存（无编辑态；false/取消勾选 = 清值） */
export function CheckboxEditor({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle(): void;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      className="accent-primary"
      aria-label="勾选属性"
    />
  );
}

function ChoiceRow({
  choice,
  selected,
  onClick,
}: {
  choice: Choice;
  selected: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-sunken ${
        selected ? "text-primary" : "text-ink"
      }`}
    >
      {choice.color && (
        <span className={`ac-badge px-1.5 py-0 text-[11px] ${LABEL_COLOR_CLASS[choice.color] ?? ""}`}>
          {choice.name}
        </span>
      )}
      {!choice.color && <span className="truncate">{choice.name}</span>}
      {selected && <span className="ml-auto text-[10px]">✓</span>}
    </button>
  );
}

/** 单选（选项/成员/里程碑/状态等）：点选即提交；allowClear 提供「无」项 */
export function ChoicesEditor({
  choices,
  selected,
  variant = "popover",
  allowClear = true,
  onSubmit,
  onClose,
}: {
  choices: Choice[];
  selected?: string | null;
  variant?: "popover" | "inline";
  allowClear?: boolean;
  onSubmit(value: string | null): void;
  onClose(): void;
}) {
  return (
    <EditorShell variant={variant} onClose={onClose}>
      {allowClear && (
        <button
          type="button"
          onClick={() => onSubmit(null)}
          className="flex w-full items-center rounded px-2 py-1 text-left text-xs text-ink-faint hover:bg-sunken"
        >
          无
        </button>
      )}
      {choices.map((c) => (
        <ChoiceRow key={c.id} choice={c} selected={selected === c.id} onClick={() => onSubmit(c.id)} />
      ))}
    </EditorShell>
  );
}

/** 多选（标签/多选属性）：勾选即以全量列表提交（服务端全量替换语义） */
export function MultiChoicesEditor({
  choices,
  selected,
  variant = "popover",
  onSubmit,
  onClose,
}: {
  choices: Choice[];
  selected: string[];
  variant?: "popover" | "inline";
  onSubmit(ids: string[]): void;
  onClose(): void;
}) {
  const [draft, setDraft] = useState<Set<string>>(new Set(selected));
  const toggle = (id: string) => {
    const next = new Set(draft);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setDraft(next);
    onSubmit([...next]); // 勾选即提交全量（与编辑表单「空=清空」语义一致）
  };
  return (
    <EditorShell variant={variant} onClose={onClose}>
      {choices.length === 0 && <p className="px-2 py-1.5 text-xs text-ink-faint">暂无可选项</p>}
      {choices.map((c) => (
        <label
          key={c.id}
          className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-ink hover:bg-sunken"
        >
          <input
            type="checkbox"
            checked={draft.has(c.id)}
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
      <div className="mt-1 border-t border-line pt-1">
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded px-2 py-1 text-left text-xs text-ink-faint hover:bg-sunken"
        >
          完成
        </button>
      </div>
    </EditorShell>
  );
}
