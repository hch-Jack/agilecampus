"use client";

import { useEffect, useState } from "react";
import type { GeneratedFileEntry } from "@/lib/agent/assistant-panel-shared";

/**
 * 面板顶部的两个检索入口（互斥展开，共用一整行按钮）：
 *
 * - 「标签」：我给助手消息打过的标签 → 点开标签列出相关历史消息；
 * - 「生成文件」：我让助手生成过的全部文件（跨会话，最近的在前）→ 点一条跳回
 *   当时那条答复（那里可预览），右侧可直接下载。
 *
 * 两块都默认收起 —— 面板高度宝贵，都是偶尔用的检索入口。每次展开都重新拉一次，
 * 因为聊天区可能刚加了标签 / 刚生成了文件。
 * 展开时在点击里同步发起请求（不写 effect 预取）：同步 setLoading 会触发
 * react-hooks/set-state-in-effect。「生成文件」的数量另外做静默刷新：挂载时与
 * 助手每生成一批文件后（filesVersion 变化）重拉一次，不设 loading，所以顶部
 * 数量不用展开面板也能实时更新。
 */

type BoardPanel = "tags" | "files";

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

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 文件卡片左侧的扩展名角标（如 PDF / DOCX），太长就取前 4 个字符 */
function fileBadge(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot === -1 ? "" : filename.slice(dot + 1).toUpperCase();
  return (ext || "FILE").slice(0, 4);
}

const CHEVRON = (
  <svg
    viewBox="0 0 24 24"
    className="h-3.5 w-3.5 shrink-0 transition-transform"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M9 6l6 6-6 6" />
  </svg>
);

const TAG_ICON = (
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
);

const FILE_ICON = (
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
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M9 13h6M9 17h6" />
  </svg>
);

export function AssistantBoards({
  onOpenMessage,
  busy,
  filesVersion = 0,
}: {
  /** 跳转到某条会话里的某条消息（外壳负责切换会话并定位） */
  onOpenMessage: (conversationId: string, messageId: string) => void;
  /** 外壳正在切换会话：暂时不让点结果 */
  busy: boolean;
  /** 助手每生成一批文件就 +1：用来静默刷新「生成文件」数量 */
  filesVersion?: number;
}) {
  const [panel, setPanel] = useState<BoardPanel | null>(null);

  // ---- 标签 ----
  const [tags, setTags] = useState<TagSummary[] | null>(null);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [tagMessages, setTagMessages] = useState<TaggedMessage[]>([]);
  const [tagMessagesLoading, setTagMessagesLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);

  // ---- 生成文件 ----
  const [files, setFiles] = useState<GeneratedFileEntry[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  async function loadTags() {
    setTagsLoading(true);
    setTagsError(null);
    try {
      const res = await fetch("/api/chat/tags");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTagsError(data.error ?? "加载标签失败");
        return;
      }
      if (Array.isArray(data.tags)) setTags(data.tags);
    } catch {
      setTagsError("网络异常，请重试");
    } finally {
      setTagsLoading(false);
    }
  }

  async function loadFiles() {
    setFilesLoading(true);
    setFilesError(null);
    try {
      const res = await fetch("/api/chat/files");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFilesError(data.error ?? "加载文件失败");
        return;
      }
      if (Array.isArray(data.files)) setFiles(data.files);
    } catch {
      setFilesError("网络异常，请重试");
    } finally {
      setFilesLoading(false);
    }
  }

  // 顶部「生成文件 · N 个」在不展开面板时也要准：挂载时、以及助手每生成一批文件后
  // 静默重拉。setFiles 在 await 之后才执行，不会触发 react-hooks/set-state-in-effect；
  // 失败也不打扰用户 —— 展开面板时会再拉一次并给出错误提示。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/chat/files");
        if (!res.ok) return;
        const data = await res.json().catch(() => ({}));
        if (!cancelled && Array.isArray(data.files)) setFiles(data.files);
      } catch {
        // 静默失败，见上
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filesVersion]);

  function toggle(next: BoardPanel) {
    if (panel === next) {
      setPanel(null);
      return;
    }
    setPanel(next);
    if (next === "tags") void loadTags();
    else void loadFiles();
  }

  async function selectTag(tag: string) {
    if (selectedTag === tag) {
      setSelectedTag(null);
      setTagMessages([]);
      return;
    }
    setSelectedTag(tag);
    setTagMessagesLoading(true);
    setTagsError(null);
    try {
      const res = await fetch(`/api/chat/tags?tag=${encodeURIComponent(tag)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTagsError(data.error ?? "查询失败");
        return;
      }
      setTagMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch {
      setTagsError("网络异常，请重试");
    } finally {
      setTagMessagesLoading(false);
    }
  }

  function openMessage(conversationId: string, messageId: string) {
    setPanel(null);
    onOpenMessage(conversationId, messageId);
  }

  return (
    <div className="shrink-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <button
          type="button"
          onClick={() => toggle("tags")}
          aria-expanded={panel === "tags"}
          aria-controls="assistant-tag-board"
          className="-mx-1 flex items-center gap-1.5 rounded-field px-1.5 py-1 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
        >
          <span className={panel === "tags" ? "rotate-90" : ""}>{CHEVRON}</span>
          {TAG_ICON}
          <span className="font-medium">标签</span>
          {tags && tags.length > 0 && <span className="text-ink-faint">· {tags.length} 个</span>}
        </button>

        <button
          type="button"
          onClick={() => toggle("files")}
          aria-expanded={panel === "files"}
          aria-controls="assistant-file-board"
          className="-mx-1 flex items-center gap-1.5 rounded-field px-1.5 py-1 text-[13px] text-ink-soft transition-colors hover:bg-sunken hover:text-ink"
        >
          <span className={panel === "files" ? "rotate-90" : ""}>{CHEVRON}</span>
          {FILE_ICON}
          <span className="font-medium">生成文件</span>
          {files && files.length > 0 && (
            <span className="text-ink-faint">· {files.length} 个</span>
          )}
        </button>
      </div>

      {panel === "tags" && (
        <div
          id="assistant-tag-board"
          className="mt-1.5 max-h-60 overflow-y-auto rounded-field border border-line bg-sunken/50 p-1.5 [scrollbar-gutter:stable]"
        >
          {tagsLoading && tags === null ? (
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
              {tagMessagesLoading ? (
                <p className="px-2 py-1.5 text-xs text-ink-faint">查询中…</p>
              ) : tagMessages.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-ink-faint">这个标签下没有消息了</p>
              ) : (
                <ul className="space-y-0.5">
                  {tagMessages.map((m) => (
                    <li key={m.messageId}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => openMessage(m.conversationId, m.messageId)}
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

          {tagsError && <p className="px-2 py-1 text-[11px] text-high">{tagsError}</p>}
        </div>
      )}

      {panel === "files" && (
        <div
          id="assistant-file-board"
          className="mt-1.5 max-h-60 overflow-y-auto rounded-field border border-line bg-sunken/50 p-1.5 [scrollbar-gutter:stable]"
        >
          {filesLoading && files === null ? (
            <p className="px-2 py-1.5 text-xs text-ink-faint">加载中…</p>
          ) : files && files.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-ink-faint">
              还没有生成过文件。让助手写文档 / 表格 / PPT 后会出现在这里。
            </p>
          ) : (
            <ul className="space-y-0.5">
              {files?.map((f) => (
                <li
                  key={f.url}
                  className="flex items-center gap-2 rounded px-1.5 py-1.5 transition-colors hover:bg-surface"
                >
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => openMessage(f.conversationId, f.messageId)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:opacity-60"
                    title="跳到生成它的那条答复"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded bg-primary-soft text-[10px] font-semibold uppercase text-primary">
                      {fileBadge(f.filename)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-medium text-ink">
                        {f.filename}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-ink-faint">
                        {f.conversationTitle ?? "新对话"} · {timeLabel(f.createdAt)} ·{" "}
                        {fmtSize(f.size)}
                      </span>
                    </span>
                  </button>
                  <a
                    href={f.url}
                    download={f.filename}
                    className="ac-btn-ghost shrink-0 px-2 py-1 text-[11px]"
                    title="下载"
                  >
                    下载
                  </a>
                </li>
              ))}
            </ul>
          )}

          {filesError && <p className="px-2 py-1 text-[11px] text-high">{filesError}</p>}
        </div>
      )}
    </div>
  );
}
