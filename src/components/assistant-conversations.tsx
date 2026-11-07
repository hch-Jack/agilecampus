"use client";

import { useMemo, useState } from "react";
import type { AssistantConversationSummary } from "@/lib/agent/assistant-panel-shared";
import {
  CONVERSATION_CATEGORY_PRESETS,
  categoryLabel,
  compareConversationCategories,
} from "@/lib/agent/conversation-category";

/** 当前分类是不是内置预设（导入的旧数据可能有自定义名，也要出现在下拉里） */
function isPreset(value: string): boolean {
  return (CONVERSATION_CATEGORY_PRESETS as readonly string[]).includes(value);
}

/**
 * 面板顶部的会话列表：新建、切换、行内改名、删除、分类。
 *
 * 分类有两条路：每行的小下拉手动指定；表头「自动归类」给所有未分类会话按关键词
 * 归类。列表按分类分桶，桶内仍按最近使用排序 —— 分类只是「分组」，不改顺序。
 *
 * 刻意做成**正常文档流里的可折叠块**，不用 absolute/fixed 弹层：
 * 抽屉本身带 transform（宇宙主题还有 backdrop-filter），绝对定位会被限制在抽屉/滚动容器里。
 *
 * 列表不显示时间，靠顺序表达「最近用过」—— 避免时区格式在服务端/客户端各算一遍。
 */
export function AssistantConversations({
  conversations,
  activeId,
  busy,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onCategorize,
  onAutoCategorize,
}: {
  conversations: AssistantConversationSummary[];
  activeId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 返回错误文案；null 表示成功 */
  onRename: (id: string, title: string) => Promise<string | null>;
  onDelete: (id: string) => void;
  /** 手动改分类；category=null 表示「未分类」。返回错误文案；null 表示成功 */
  onCategorize: (id: string, category: string | null) => Promise<string | null>;
  /** 自动归类所有未分类会话，返回错误文案；null 表示成功 */
  onAutoCategorize: () => Promise<string | null>;
}) {
  // 会话多了才默认展开；只有一条时收起，把高度留给消息
  const [open, setOpen] = useState(conversations.length > 1);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [categorizingId, setCategorizingId] = useState<string | null>(null);
  const [autoCategorizing, setAutoCategorizing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeTitle =
    conversations.find((c) => c.id === activeId)?.title ?? "新对话";
  const hasUncategorized = conversations.some((c) => !c.category);

  // 按分类分桶：桶按预设/自定义/未分类排序，桶内保留传入的「最近用过」顺序
  const groups = useMemo(() => {
    const map = new Map<string | null, AssistantConversationSummary[]>();
    for (const c of conversations) {
      const key = c.category ?? null;
      const bucket = map.get(key);
      if (bucket) bucket.push(c);
      else map.set(key, [c]);
    }
    return [...map.entries()].sort(([a], [b]) => compareConversationCategories(a, b));
  }, [conversations]);
  // 全部都是未分类时不必显示「未分类」小标题，把高度留给消息
  const showGroupHeaders = groups.length > 1 || groups[0]?.[0] != null;

  async function changeCategory(id: string, value: string) {
    if (categorizingId) return;
    setCategorizingId(id);
    setError(null);
    try {
      const message = await onCategorize(id, value || null);
      if (message) setError(message);
    } finally {
      setCategorizingId(null);
    }
  }

  async function autoCategorize() {
    if (autoCategorizing) return;
    setAutoCategorizing(true);
    setError(null);
    try {
      const message = await onAutoCategorize();
      if (message) setError(message);
    } finally {
      setAutoCategorizing(false);
    }
  }

  function startEdit(c: AssistantConversationSummary) {
    setError(null);
    setEditingId(c.id);
    setDraft(c.title ?? "新对话");
  }

  async function submitRename(id: string) {
    const title = draft.trim();
    if (!title || renaming) return;
    setRenaming(true);
    setError(null);
    try {
      const message = await onRename(id, title);
      if (message) {
        setError(message);
        return;
      }
      setEditingId(null);
    } finally {
      setRenaming(false);
    }
  }

  function requestDelete(c: AssistantConversationSummary) {
    if (busy) return;
    if (!window.confirm(`删除对话「${c.title ?? "新对话"}」？其中的消息会一并删除。`)) return;
    setEditingId(null);
    onDelete(c.id);
  }

  return (
    <div className="shrink-0 border-b border-line pb-3">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="assistant-conversation-list"
          className="-mx-1 flex min-w-0 items-center gap-1.5 rounded-field px-1.5 py-1 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
        >
          <svg
            viewBox="0 0 24 24"
            className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
          <span className="shrink-0 font-medium">对话</span>
          <span className="truncate text-ink">· {activeTitle}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          {hasUncategorized && (
            <button
              type="button"
              onClick={() => void autoCategorize()}
              disabled={busy || autoCategorizing}
              title="按关键词给未分类的对话归类；手动分过类的不动"
              className="ac-btn-ghost px-2 py-1.5 text-xs text-ink-faint disabled:opacity-50"
            >
              {autoCategorizing ? "归类中…" : "自动归类"}
            </button>
          )}
          <button
            type="button"
            onClick={onNew}
            disabled={busy}
            className="ac-btn-ghost shrink-0 px-2.5 py-1.5 text-[13px] disabled:opacity-50"
          >
            ＋ 新对话
          </button>
        </div>
      </div>

      {open && (
        <div
          id="assistant-conversation-list"
          className="mt-2 max-h-60 overflow-y-auto rounded-field border border-line bg-sunken/50 p-1.5 [scrollbar-gutter:stable]"
        >
          {conversations.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-ink-faint">还没有对话</p>
          ) : (
            <ul className="space-y-1">
              {groups.map(([category, items]) => (
                <li key={category ?? "__uncategorized"}>
                  {showGroupHeaders && (
                    <div className="flex items-baseline gap-1.5 px-2.5 pb-0.5 pt-1 text-[11px] text-ink-faint">
                      <span className="font-medium text-ink-soft">{categoryLabel(category)}</span>
                      <span>· {items.length}</span>
                    </div>
                  )}
                  <ul className="space-y-0.5">
                    {items.map((c) => {
                const active = c.id === activeId;
                if (editingId === c.id) {
                  return (
                    <li key={c.id} className="flex items-center gap-1.5 px-1 py-1">
                      <input
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void submitRename(c.id);
                          }
                          if (e.key === "Escape") {
                            // 只取消改名，别顺手把整个抽屉关了
                            e.stopPropagation();
                            setEditingId(null);
                          }
                        }}
                        maxLength={60}
                        aria-label="会话标题"
                        className="ac-field min-w-0 flex-1 px-2 py-1 text-[13px]"
                      />
                      <button
                        type="button"
                        onClick={() => void submitRename(c.id)}
                        disabled={renaming || !draft.trim()}
                        className="ac-btn shrink-0 px-2 py-1 text-xs disabled:opacity-50"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="ac-btn-ghost shrink-0 px-2 py-1 text-xs"
                      >
                        取消
                      </button>
                    </li>
                  );
                }

                return (
                  <li key={c.id} className="flex items-center gap-0.5">
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      disabled={busy}
                      aria-current={active ? "true" : undefined}
                      className={`min-w-0 flex-1 truncate rounded px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-60 ${
                        active
                          ? "bg-primary-soft font-medium text-primary"
                          : "text-ink hover:bg-surface"
                      }`}
                    >
                      {c.title ?? "新对话"}
                    </button>
                    <select
                      value={c.category ?? ""}
                      onChange={(e) => void changeCategory(c.id, e.target.value)}
                      disabled={busy || categorizingId !== null}
                      aria-label="会话分类"
                      title="会话分类"
                      className="w-[5.8rem] shrink-0 cursor-pointer truncate rounded bg-transparent px-0.5 py-1 text-[11px] text-ink-faint outline-none transition-colors hover:bg-surface focus:bg-surface disabled:cursor-default disabled:opacity-50"
                    >
                      <option value="">未分类</option>
                      {CONVERSATION_CATEGORY_PRESETS.map((preset) => (
                        <option key={preset} value={preset}>
                          {preset}
                        </option>
                      ))}
                      {c.category && !isPreset(c.category) && (
                        <option value={c.category}>{c.category}</option>
                      )}
                    </select>
                    <button
                      type="button"
                      onClick={() => startEdit(c)}
                      disabled={busy}
                      aria-label="重命名对话"
                      title="重命名"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-surface hover:text-ink disabled:opacity-50"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M4 20h4l10-10-4-4L4 16v4Z" />
                        <path d="M14 6l4 4" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => requestDelete(c)}
                      disabled={busy}
                      aria-label="删除对话"
                      title="删除"
                      className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-faint transition-colors hover:bg-surface hover:text-high disabled:opacity-50"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
                        <path d="M10 11v5M14 11v5" />
                      </svg>
                    </button>
                  </li>
                );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="mt-1 text-xs text-high">{error}</p>}
    </div>
  );
}
