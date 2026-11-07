"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DraftCards, type ChatScope, type Draft, type OptionMap } from "@/components/draft-cards";
import { continuationOriginalText, isContinuationText } from "@/lib/agent/continuation";
import {
  ASSISTANT_ATTACHMENTS_MAX,
  ASSISTANT_FILE_MAX_SIZE,
  type AssistantFile,
  type AssistantNavigation,
  type MessageAttachment,
} from "@/lib/agent/assistant-panel-shared";
import { MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { MESSAGE_TAG_MAX, normalizeMessageTag } from "@/lib/message-tag";
import { uploadFileRaw } from "@/lib/upload-client";
import { Markdown } from "@/components/markdown";
import { FilePreviewModal } from "@/components/file-preview";
import { AssistantFileCards } from "@/components/assistant-file-cards";

/**
 * AI 助手对话区 —— 右侧常驻面板（`assistant-shell.tsx`）的唯一使用者。
 *
 * 打的是 `/api/chat` 的**个人** scope：会话只属于本人，可以有多条；具体落在哪条由外壳传入的
 * `conversationId` 决定（不传则后端取最近一条或自动新建，兼容旧客户端）。在项目页面里，外壳把
 * 当前项目 id 作为 `projectId` 传进来；后端把它当「焦点项目」——只影响这一轮的快照与工具面，
 * **不改变会话归属**（见 lib/agent/orchestrator.ts）。
 *
 * 个人回合的响应会额外带 `options`（草案可能指向多个项目），故按消息随行保存：上下两条消息的
 * 草案可以指向不同项目。每条助手消息还记下**那一轮用的焦点项目**，用户切到另一个项目后点
 * 「继续处理后续动作」，仍按出卡时的项目续做，而不是跟着屏幕走。
 *
 * 删除是**成对**的：删除提问或答复中的任意一条，后端都会把同一轮的两条一起删掉。列表 key
 * 必须是稳定身份（`localId ?? id`），不能用下标 —— 否则删掉前序消息后，草案卡会串到上一张卡
 * 的状态上。
 *
 * 布局是满高的：外层（壳）负责宽度与背景，这里只负责「标题行 + 可滚消息区 + 输入行」。
 */

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  /** 服务端消息 id；乐观插入的提问在保存成功前没有 */
  id?: string;
  /** 客户端稳定 key：还没落库的消息也要有身份（删除本地失败消息靠它） */
  localId?: string;
  drafts?: Draft[];
  options?: OptionMap;
  /** 生成这条答复时带的焦点项目；续做沿用它，而不是屏幕当前项目 */
  focusProjectId?: string;
  /** 助手替用户打开的页面；收到即跳转，并留一个可点回看的入口 */
  navigations?: AssistantNavigation[];
  /** 助手替用户打开的附件；收到即弹预览，并留一个可点重开的入口 */
  files?: AssistantFile[];
  /** 这条提问随行上传的文件（落库后服务端回读，刷新仍在） */
  attachments?: MessageAttachment[];
  /** 本人给这条助手消息打的标签（私有，服务端按用户过滤） */
  tags?: string[];
};

/** 文件胶囊上的大小提示；只用于 title，不需要更精细 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

let localSeq = 0;
function nextLocalId(): string {
  localSeq += 1;
  return `local-${Date.now()}-${localSeq}`;
}

export function AgentChat({
  scope,
  projectId,
  conversationId,
  initialMessages,
  title = "AI 助手",
  subtitle,
  emptyHint = "向助手提问，如「当前进度如何？」或「把调研拆成任务」",
  placeholder = "问点什么…",
  disabled = false,
  actions,
  onBusyChange,
  onTurnPersisted,
  onTurnDeleted,
  focusMessage,
}: {
  scope: ChatScope;
  /** 当前页面所在项目；有值时后端把它当焦点项目（会话仍是个人会话） */
  projectId?: string;
  /** 当前个人会话；不传则由后端取最近一条或新建 */
  conversationId?: string;
  initialMessages: ChatMessage[];
  title?: string;
  subtitle?: string;
  emptyHint?: string;
  placeholder?: string;
  /** 外壳正在切换会话：只读，避免把这一轮发进下一条会话 */
  disabled?: boolean;
  /** 标题行右侧的按钮（设置链接、收起按钮） */
  actions?: ReactNode;
  /** 发送/删除期间为 true，外壳据此禁用会话切换 */
  onBusyChange?: (busy: boolean) => void;
  onTurnPersisted?: (info: {
    conversationId: string;
    conversationTitle: string | null;
    conversationCategory: string | null;
    conversationCreatedAt: string;
    lastMessageAt: string;
  }) => void;
  onTurnDeleted?: (info: {
    conversationId: string;
    deletedIds: string[];
    lastMessageAt: string | null;
  }) => void;
  /** 从「按标签查历史」跳过来时定位到的那条消息；nonce 让同一条消息也能再次触发滚动 */
  focusMessage?: { messageId: string; nonce: number };
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 正在编辑标签的消息 id（一次只开一个行内编辑器） */
  const [tagEditorId, setTagEditorId] = useState<string | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  /** 标签请求在飞的消息 id：只禁这一条的按钮，不影响继续聊天 */
  const [tagBusyId, setTagBusyId] = useState<string | null>(null);
  const [tagError, setTagError] = useState<string | null>(null);
  /** 从标签检索跳转过来的目标消息：滚动到位后短暂高亮 */
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** 当前正在预览的附件（助手 open_file 自动弹出，或用户点消息里的入口） */
  const [previewFile, setPreviewFile] = useState<AssistantFile | null>(null);
  /** 已上传、还没随消息发出去的文件（文件主人只有自己，见 /api/assistant/files） */
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 翻历史时别被后续消息（答复、删除、pending 切换）拽回底部：
  // 只有本来就贴着底、或自己刚发出一条时才自动跟到底
  const atBottomRef = useRef(true);
  const forceBottomRef = useRef(false);
  const router = useRouter();

  const busy = pending || deletingId !== null;

  // 通知外壳：有请求在飞时别让用户切走会话
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // 消息区是唯一可滚动的部分：贴底的人要一直跟到最新（刚发出的那句、随后落下来的答复，
  // 还带一叠草案卡）；正在往上翻历史的人则保持原位，别被回答到达 / 删除一轮打断。
  // 依赖里带上 pending：从「思考中…」转回结果时再贴一次，等卡片撑开也不会露在半路。
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (forceBottomRef.current || atBottomRef.current) {
      forceBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pending]);

  // 「按标签查历史」跳过来：滚到目标消息并短暂高亮。目标可能已不在最近 200 条里 ——
  // 那就只是切到了那条会话，不硬报错。nonce 保证同一条消息连点两次也会再次滚动。
  const lastFocusNonce = useRef(-1);
  useEffect(() => {
    if (!focusMessage || lastFocusNonce.current === focusMessage.nonce) return;
    lastFocusNonce.current = focusMessage.nonce;
    const target = document.getElementById(`ac-msg-${focusMessage.messageId}`);
    if (!target) return;
    // 用户在翻历史：别让后续消息把人拽回底部
    atBottomRef.current = false;
    forceBottomRef.current = false;
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    // setState 放进定时器回调：既躲开 react-hooks/set-state-in-effect，
    // 也让高亮从下一拍开始，不和滚动同一帧抢渲染
    const highlightTimer = window.setTimeout(
      () => setHighlightId(focusMessage.messageId),
      0,
    );
    const clearTimer = window.setTimeout(() => {
      setHighlightId((id) => (id === focusMessage.messageId ? null : id));
    }, 2400);
    return () => {
      window.clearTimeout(highlightTimer);
      window.clearTimeout(clearTimer);
    };
  }, [focusMessage]);

  function handleListScroll() {
    const el = listRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    if (!atBottomRef.current) forceBottomRef.current = false;
  }

  /**
   * 发送一句话。`focus` 是这一轮带的项目上下文 —— 默认取屏幕上的当前项目；
   * 「继续处理后续动作」会显式传入**出卡时**的项目，避免切页后续做到别的项目上。
   */
  async function sendText(
    text: string,
    focus = projectId,
    withFiles: MessageAttachment[] = [],
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || pending || disabled) return false;
    setError(null);
    const localId = nextLocalId();
    // 自己刚发出一条：即便刚才在翻历史，也要把这条与随后的答复带进视野
    atBottomRef.current = true;
    forceBottomRef.current = true;
    setMessages((m) => [
      ...m,
      {
        role: "user",
        content: trimmed,
        localId,
        ...(withFiles.length > 0 ? { attachments: withFiles } : {}),
      },
    ]);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // focus 为 undefined 时 JSON 里不会出现 projectId 键，后端按「没有当前项目」处理
        body: JSON.stringify({
          scope,
          projectId: focus,
          userText: trimmed,
          ...(conversationId ? { conversationId } : {}),
          ...(withFiles.length > 0 ? { attachmentIds: withFiles.map((f) => f.id) } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "对话失败");
        return false;
      }
      const navigations: AssistantNavigation[] = Array.isArray(data.navigations)
        ? data.navigations
        : [];
      const files: AssistantFile[] = Array.isArray(data.files)
        ? data.files.filter(
            (f: AssistantFile) => f && typeof f.url === "string" && typeof f.filename === "string",
          )
        : [];
      setMessages((m) => {
        const next = [...m];
        // 按 localId 回填服务端 id —— 这样这条提问也能成对删除
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].localId === localId) {
            next[i] = { ...next[i], id: data.userMessageId };
            break;
          }
        }
        next.push({
          role: "assistant",
          content: data.text,
          id: data.assistantMessageId,
          drafts: data.drafts,
          options: data.options,
          focusProjectId: focus,
          navigations: navigations.length > 0 ? navigations : undefined,
          files: files.length > 0 ? files : undefined,
        });
        return next;
      });
      // 「打开某页」立即生效：多次跳转只认最后一个（前面的还没看就被换掉了没意义）。
      // 面板挂在 layout 里，换页不会把这段对话连同未确认的草案卡一起卸载。
      const navTarget = navigations.at(-1);
      if (navTarget) router.push(navTarget.href);
      // 「打开某文件」同理：直接弹预览，消息下仍留一个可重开的入口。
      // 生成的文件（autoOpen=false）不弹 —— 别让全屏预览挡住刚生成的文件卡。
      const fileTarget = [...files].reverse().find((f) => f.autoOpen !== false);
      if (fileTarget) setPreviewFile(fileTarget);
      // 外壳据此把「懒建出的会话」放进列表；**不**触发 remount，否则刚发的消息会消失
      if (data.conversationId) {
        onTurnPersisted?.({
          conversationId: data.conversationId,
          conversationTitle: data.conversationTitle ?? null,
          conversationCategory: data.conversationCategory ?? null,
          conversationCreatedAt: data.conversationCreatedAt,
          lastMessageAt: data.lastMessageAt,
        });
      }
      return true;
    } catch {
      setError("网络异常，请重试");
      return false;
    } finally {
      setPending(false);
    }
  }

  function send() {
    const text = input.trim();
    if (!text || pending || disabled || uploading) return;
    setInput("");
    const files = attachments;
    setAttachments([]);
    void sendText(text, projectId, files);
  }

  /** 选中的文件逐个传上去：一个失败不影响其余，失败原因留在输入框上方 */
  async function uploadFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setUploadError(null);
    const room = ASSISTANT_ATTACHMENTS_MAX - attachments.length;
    const picked = [...fileList];
    if (room <= 0) {
      setUploadError(`一句话最多带 ${ASSISTANT_ATTACHMENTS_MAX} 个文件`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (picked.length > room) setUploadError(`最多再加 ${room} 个文件，多余的已忽略`);

    setUploading(true);
    for (const file of picked.slice(0, room)) {
      // 超限的本地先拦：不必把大文件白传一遍，服务端还会再校一次
      if (file.size > ASSISTANT_FILE_MAX_SIZE) {
        setUploadError(`「${file.name}」超过 ${MAX_FILE_SIZE_LABEL}，未上传`);
        continue;
      }
      const up = await uploadFileRaw<{
        id: string;
        filename: string;
        mimeType: string | null;
        size: number;
      }>("/api/assistant/files", file);
      if (!up.ok) {
        setUploadError(`「${file.name}」上传失败：${up.error}`);
        continue;
      }
      const uploaded: MessageAttachment = {
        id: up.data.id,
        filename: up.data.filename,
        mimeType: up.data.mimeType,
        size: up.data.size,
      };
      setAttachments((list) => [...list, uploaded]);
    }
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  /** 发送前撤掉一个文件：顺手删掉服务端那份，别留下没人引用的孤儿 */
  function removeAttachment(id: string) {
    setAttachments((list) => list.filter((f) => f.id !== id));
    void fetch(`/api/assistant/files/${id}`, { method: "DELETE" }).catch(() => {});
  }

  function toggleTagEditor(messageId: string) {
    setTagEditorId((prev) => (prev === messageId ? null : messageId));
    setTagDraft("");
    setTagError(null);
  }

  function applyMessageTags(messageId: string, tags: string[]) {
    setMessages((ms) =>
      ms.map((m) =>
        m.id === messageId ? { ...m, tags: tags.length > 0 ? tags : undefined } : m,
      ),
    );
  }

  /** 给助手消息加一个标签；重复添加由服务端幂等处理 */
  async function addTag(messageId: string) {
    const tag = normalizeMessageTag(tagDraft);
    if (!tag) {
      setTagError("请输入标签");
      return;
    }
    if (tagBusyId) return;
    setTagBusyId(messageId);
    setTagError(null);
    try {
      const res = await fetch(`/api/chat/messages/${messageId}/tags`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTagError(data.error ?? "添加标签失败");
        return;
      }
      applyMessageTags(messageId, Array.isArray(data.tags) ? data.tags : []);
      setTagDraft("");
    } catch {
      setTagError("网络异常，请重试");
    } finally {
      setTagBusyId(null);
    }
  }

  async function removeTag(messageId: string, tag: string) {
    if (tagBusyId) return;
    setTagBusyId(messageId);
    setTagError(null);
    try {
      const res = await fetch(
        `/api/chat/messages/${messageId}/tags?tag=${encodeURIComponent(tag)}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setTagError(data.error ?? "移除标签失败");
        return;
      }
      // 服务端不回整表；本地按已知标签过滤即可（撤回是幂等的）
      setMessages((ms) =>
        ms.map((m) => {
          if (m.id !== messageId) return m;
          const tags = (m.tags ?? []).filter((t) => t !== tag);
          return { ...m, tags: tags.length > 0 ? tags : undefined };
        }),
      );
    } catch {
      setTagError("网络异常，请重试");
    } finally {
      setTagBusyId(null);
    }
  }

  async function deleteTurn(m: ChatMessage) {
    if (pending || deletingId || disabled) return;

    // 没落库的消息（发送失败 / 还在乐观阶段）只从本地移除
    if (!m.id) {
      if (!m.localId) return;
      setMessages((ms) => ms.filter((x) => x.localId !== m.localId));
      return;
    }

    if (
      !window.confirm(
        "删除这一轮对话？你的消息和助手的回复会一起删掉；已确认落库的改动不会撤销。",
      )
    ) {
      return;
    }

    setDeletingId(m.id);
    setError(null);
    try {
      const res = await fetch(`/api/chat/messages/${m.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "删除失败");
        return;
      }
      const gone = new Set<string>(
        Array.isArray(data.deletedIds) ? data.deletedIds : [],
      );
      gone.add(m.id);
      setMessages((ms) => ms.filter((x) => !(x.id && gone.has(x.id))));
      if (data.conversationId) {
        onTurnDeleted?.({
          conversationId: data.conversationId,
          deletedIds: [...gone],
          lastMessageAt: data.lastMessageAt ?? null,
        });
      }
    } catch {
      setError("网络异常，请重试");
    } finally {
      setDeletingId(null);
    }
  }

  // 续做请求在飞时，最后一条消息是那条「继续上一轮」提示词。
  // 用它在底部给出明确状态，而不是只把发送按钮改成「思考中…」。
  const lastMessage = messages[messages.length - 1];
  const continuingTurn =
    pending && lastMessage?.role === "user" && isContinuationText(lastMessage.content);

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold tracking-tight text-ink">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-xs leading-relaxed text-ink-faint">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>

      {/* pr-3 + scrollbar-gutter：Windows 的覆盖式滚动条会画在内容右缘，
          草案行尾的删除键曾因此点不到。留出稳定槽位，滚动条出现与否都不压按钮。 */}
      <div
        ref={listRef}
        onScroll={handleListScroll}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-3 [scrollbar-gutter:stable]"
      >
        {messages.map((m, i) => {
          // 「继续处理后续动作」发出去的是写给模型的提示词（原请求复述 + 续做规矩），
          // 界面上只留一行「继续上一轮请求」，别把机器话术摊给用户看。
          const continuation = m.role === "user" && isContinuationText(m.content);
          const deleteButton = (
            <button
              type="button"
              onClick={() => void deleteTurn(m)}
              disabled={busy || disabled}
              aria-label={
                continuation
                  ? "删除这一轮对话（继续上一轮请求）"
                  : m.role === "user"
                    ? "删除这一轮对话（我的提问）"
                    : "删除这一轮对话（助手的回答）"
              }
              title="删除这一轮"
              className="grid h-7 w-7 shrink-0 place-items-center rounded text-ink-faint/70 transition-colors hover:bg-surface hover:text-high disabled:opacity-40"
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
          );
          // 只有落库后的助手消息才有 id，也才谈得上打标签
          const tagButton =
            m.role === "assistant" && m.id ? (
              <button
                type="button"
                onClick={() => toggleTagEditor(m.id!)}
                aria-label="添加标签"
                aria-expanded={tagEditorId === m.id}
                title="标签"
                className={`grid h-7 w-7 shrink-0 place-items-center rounded transition-colors hover:bg-surface ${
                  tagEditorId === m.id || (m.tags?.length ?? 0) > 0
                    ? "text-primary"
                    : "text-ink-faint/70 hover:text-ink"
                }`}
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
                  <path d="M20.6 13.4 11 3.8H4v7l9.6 9.6a2 2 0 0 0 2.8 0l4.2-4.2a2 2 0 0 0 0-2.8Z" />
                  <circle cx="7.5" cy="7.5" r="1" />
                </svg>
              </button>
            ) : null;

          return (
            <div
              key={m.localId ?? m.id ?? `idx-${i}`}
              id={m.id ? `ac-msg-${m.id}` : undefined}
              className={
                highlightId && highlightId === m.id
                  ? "-m-1 rounded-lg p-1 ring-2 ring-primary/50 transition-shadow"
                  : undefined
              }
            >
              {continuation ? (
                <div
                  className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${
                    pending && i === messages.length - 1
                      ? "border-primary/40 bg-primary-soft/60 text-primary"
                      : "border-line bg-sunken/50 text-ink-faint"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <svg
                      viewBox="0 0 24 24"
                      className={`h-3.5 w-3.5 shrink-0 ${
                        pending && i === messages.length - 1 ? "animate-spin" : ""
                      }`}
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                    <span className="truncate">
                      {pending && i === messages.length - 1
                        ? "正在继续处理后续动作…"
                        : "继续上一轮请求"}
                    </span>
                  </span>
                  {deleteButton}
                </div>
              ) : (
                <div
                  className={`rounded-lg p-2.5 text-sm ${m.role === "user" ? "bg-sunken" : "bg-primary-soft"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs text-ink-faint">{m.role === "user" ? "我" : "助手"}</span>
                    <div className="-mt-1 flex items-center">
                      {tagButton}
                      {deleteButton}
                    </div>
                  </div>
                  {/* 助手按 Markdown 渲染；用户自己敲的字保持原样，别把 * 和 # 也吃进去 */}
                  <div className="mt-1 text-ink">
                    {m.role === "assistant" ? (
                      <Markdown>{m.content}</Markdown>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    )}
                  </div>
                  {m.tags && m.tags.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.tags.map((tag) => (
                        <span key={tag} className="ac-badge bg-surface text-ink-soft">
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.role === "assistant" && m.id && tagEditorId === m.id && (
                    <div className="mt-2 space-y-1.5 rounded-field border border-line bg-surface/80 p-2">
                      {m.tags && m.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                          {m.tags.map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => void removeTag(m.id!, tag)}
                              disabled={tagBusyId === m.id}
                              title="点击移除这个标签"
                              className="ac-badge bg-primary-soft text-primary hover:bg-high hover:text-white disabled:opacity-50"
                            >
                              {tag} <span aria-hidden>×</span>
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1.5">
                        <input
                          value={tagDraft}
                          onChange={(e) => setTagDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void addTag(m.id!);
                            }
                            if (e.key === "Escape") {
                              // 只关标签编辑器，别把整个抽屉关了
                              e.stopPropagation();
                              toggleTagEditor(m.id!);
                            }
                          }}
                          maxLength={MESSAGE_TAG_MAX}
                          placeholder="标签名，回车添加"
                          aria-label="消息标签"
                          className="ac-field min-w-0 flex-1 px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => void addTag(m.id!)}
                          disabled={tagBusyId === m.id || !tagDraft.trim()}
                          className="ac-btn shrink-0 px-2 py-1 text-xs disabled:opacity-50"
                        >
                          添加
                        </button>
                        <button
                          type="button"
                          onClick={() => toggleTagEditor(m.id!)}
                          className="ac-btn-ghost shrink-0 px-2 py-1 text-xs"
                        >
                          关闭
                        </button>
                      </div>
                      {tagError && <p className="text-[11px] text-high">{tagError}</p>}
                    </div>
                  )}
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.attachments.map((a) => (
                        <a
                          key={a.id}
                          href={`/api/assistant/files/${a.id}`}
                          download={a.filename}
                          title={`${a.filename}（${formatFileSize(a.size)}）`}
                          className="ac-badge max-w-full truncate bg-surface text-ink-soft hover:bg-primary-soft hover:text-primary"
                        >
                          {a.filename}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {m.navigations && m.navigations.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {m.navigations.map((n) => (
                    <Link
                      key={n.href}
                      href={n.href}
                      // 助手已经替用户跳过去了；这里留一个回头再点的入口
                      className="ac-badge bg-primary text-white hover:bg-primary-hover"
                    >
                      打开{n.label}
                    </Link>
                  ))}
                </div>
              )}
              {m.files && m.files.length > 0 && (
                // 已经自动弹过一次预览；关掉后这里可以再预览，也可以直接下载
                <AssistantFileCards files={m.files} onPreview={setPreviewFile} />
              )}
              {m.drafts && m.drafts.length > 0 && (
                <DraftCards
                  drafts={m.drafts}
                  options={m.options ?? {}}
                  // 草案卡的项目下拉随这一轮走，而不是随当前页面走
                  defaultProjectId={m.focusProjectId ?? projectId}
                  scope={scope}
                  // 「继续」要复述用户最初那句话；助手消息前一条正是它。若上一轮本身也是
                  // 「继续」，这里取回最初的请求，而不是把整段提示词再套一层。
                  originalText={
                    i > 0 && messages[i - 1].role === "user"
                      ? continuationOriginalText(messages[i - 1].content)
                      : ""
                  }
                  busy={pending || disabled}
                  onContinue={(text) => sendText(text, m.focusProjectId)}
                />
              )}
            </div>
          );
        })}
        {messages.length === 0 && <p className="text-sm text-ink-soft">{emptyHint}</p>}
        {/* 续做时上一条已经是带转圈的「正在继续处理后续动作…」，这里不再重复 */}
        {pending && !continuingTurn && (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2 px-1 py-1 text-xs text-ink-soft"
          >
            <span className="flex items-center gap-1" aria-hidden>
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
                style={{ animationDelay: "-0.3s" }}
              />
              <span
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary"
                style={{ animationDelay: "-0.15s" }}
              />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary" />
            </span>
            <span>助手正在处理…</span>
          </div>
        )}
      </div>
      {error && <p className="shrink-0 text-sm text-high">{error}</p>}
      {(uploadError || (scope === "personal" && attachments.length > 0)) && (
        <div className="shrink-0 space-y-1">
          {scope === "personal" && attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a) => (
                <span
                  key={a.id}
                  className="ac-badge max-w-full bg-surface text-ink-soft"
                  title={`${a.filename}（${formatFileSize(a.size)}）`}
                >
                  <span className="max-w-[10rem] truncate">{a.filename}</span>
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    aria-label={`移除 ${a.filename}`}
                    className="text-ink-faint transition-colors hover:text-high"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {uploadError && <p className="text-xs text-high">{uploadError}</p>}
        </div>
      )}
      <div className="flex shrink-0 gap-2">
        {/* 上传只开在个人助手：项目助手会话是团队共享的，文件却有主人 */}
        {scope === "personal" && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void uploadFiles(e.target.files)}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={
                pending ||
                disabled ||
                uploading ||
                attachments.length >= ASSISTANT_ATTACHMENTS_MAX
              }
              aria-label="添加文件"
              title={`添加文件（≤${MAX_FILE_SIZE_LABEL}，最多 ${ASSISTANT_ATTACHMENTS_MAX} 个）`}
              className="ac-btn-ghost shrink-0 px-2 py-2 text-sm"
            >
              {uploading ? (
                <span className="text-xs text-ink-faint">…</span>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l9-9a3.4 3.4 0 014.8 4.8l-9 9a1.8 1.8 0 01-2.5-2.5l8.2-8.2" />
                </svg>
              )}
            </button>
          </>
        )}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={placeholder}
          className="ac-field flex-1 text-sm"
          disabled={pending || disabled || uploading}
        />
        <button
          onClick={send}
          disabled={pending || disabled || uploading}
          className="ac-btn px-3 py-2 text-sm"
        >
          {pending ? "思考中…" : "发送"}
        </button>
      </div>
      {/* 挂到 body：面板自身有宽度/层级约束，弹窗不能被它裁掉或压住 */}
      {previewFile &&
        createPortal(
          <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />,
          document.body,
        )}
    </section>
  );
}
