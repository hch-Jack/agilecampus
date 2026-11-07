"use client";

import { useState } from "react";

/**
 * 面板里的「标签」检索板：列出我给助手消息打过的标签，点开一个标签就列出相关历史消息，
 * 再点一条消息跳到它所在的会话并定位。
 *
 * 默认收起 —— 面板高度宝贵，标签是偶尔用的检索入口。每次展开都重新拉一次标签，
 * 因为聊天区可能刚加了新标签。
 */

type TagSummary = { tag: string; count: number };

type TaggedMessage = {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  content: string;
  createdAt: string; // ISO
  tags: string[];
};

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AssistantTagBoard({
  onOpenMessage,
  busy,
}: {
  /** 跳转到某条会话里的某条消息（外壳负责切换会话并定位） */
  onOpenMessage: (conversationId: string, messageId: string) => void;
  /** 外壳正在切换会话：暂时不让点结果 */
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [messages, setMessages] = useState<TaggedMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * 每次展开都刷新：聊天区可能刚加了标签。
   * 刻意不用 effect —— 同步 setLoading 会触发 react-hooks/set-state-in-effect；
   * 展开是用户动作，直接在这里发起最自然。
   */
  async function loadTags() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/chat/tags");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "加载标签失败");
        return;
      }
      if (Array.isArray(data.tags)) setTags(data.tags);
    } catch {
      setError("网络异常，请重试");
    } finally {
      setLoading(false);
    }
  }

  function toggleBoard() {
    if (!open) void loadTags();
    setOpen(!open);
  }

  async function selectTag(tag: string) {
    if (selectedTag === tag) {
      setSelectedTag(null);
      setMessages([]);
      return;
    }
    setSelectedTag(tag);
    setMessagesLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/chat/tags?tag=${encodeURIComponent(tag)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "查询失败");
        return;
      }
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch {
      setError("网络异常，请重试");
    } finally {
      setMessagesLoading(false);
    }
  }

  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={toggleBoard}
        aria-expanded={open}
        aria-controls="assistant-tag-board"
        className="-mx-1 flex items-center gap-1.5 rounded-field px-1.5 py-1 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
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
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 shrink-0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M20.6 13.4 11 3.8H4v7l9.6 9.6a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8Z" />
          <circle cx="7.5" cy="7.5" r="1" />
        </svg>
        <span className="font-medium">标签</span>
        {tags && tags.length > 0 && (
          <span className="text-ink-faint">· {tags.length} 个</span>
        )}
      </button>

      {open && (
        <div
          id="assistant-tag-board"
          className="mt-1.5 max-h-60 overflow-y-auto rounded-field border border-line bg-sunken/50 p-1.5 [scrollbar-gutter:stable]"
        >
          {loading && tags === null ? (
            <p className="px-2 py-1.5 text-xs text-ink-faint">加载中…</p>
          ) : tags && tags.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-ink-faint">
              还没有标签。在助手答复右上角点标签图标即可添加。
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5 px-1 py-1">
              {tags?.map(({ tag, count }) => (
                <button
                  key={tag}
                  type="button"
                  onClick={() => void selectTag(tag)}
                  aria-pressed={selectedTag === tag}
                  className={`ac-badge ${
                    selectedTag === tag
                      ? "bg-primary text-white"
                      : "bg-surface text-ink-soft hover:bg-primary-soft hover:text-primary"
                  }`}
                >
                  {tag} <span className="opacity-70">· {count}</span>
                </button>
              ))}
            </div>
          )}

          {selectedTag && (
            <div className="mt-1 border-t border-line pt-1">
              {messagesLoading ? (
                <p className="px-2 py-1.5 text-xs text-ink-faint">查询中…</p>
              ) : messages.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-ink-faint">这个标签下没有消息了</p>
              ) : (
                <ul className="space-y-0.5">
                  {messages.map((m) => (
                    <li key={m.messageId}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setOpen(false);
                          onOpenMessage(m.conversationId, m.messageId);
                        }}
                        className="w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-surface disabled:opacity-60"
                        title="打开这条消息"
                      >
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 truncate text-[12px] font-medium text-ink">
                            {m.conversationTitle ?? "新对话"}
                          </span>
                          <span className="shrink-0 text-[11px] text-ink-faint">
                            {timeLabel(m.createdAt)}
                          </span>
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-ink-soft">
                          {m.content.replace(/\s+/g, " ").trim().slice(0, 80) || "（空消息）"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && <p className="px-2 py-1 text-[11px] text-high">{error}</p>}
        </div>
      )}
    </div>
  );
}
