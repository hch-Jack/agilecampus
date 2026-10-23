"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DraftCards, type ChatScope, type Draft, type OptionMap } from "@/components/draft-cards";
import { continuationOriginalText, isContinuationText } from "@/lib/agent/continuation";
import type { AssistantNavigation } from "@/lib/agent/assistant-panel-shared";
import { Markdown } from "@/components/markdown";

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
};

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
    conversationCreatedAt: string;
    lastMessageAt: string;
  }) => void;
  onTurnDeleted?: (info: {
    conversationId: string;
    deletedIds: string[];
    lastMessageAt: string | null;
  }) => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const busy = pending || deletingId !== null;

  // 通知外壳：有请求在飞时别让用户切走会话
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // 消息区是唯一可滚动的部分：不主动贴底的话，刚发出的那句、以及随后落下来的答复
  // （还带一叠草案卡）全长在视野下方，得手动往下拖才看得见 —— 看上去像「没反应」。
  // 依赖里带上 pending：从「思考中…」转回结果时再贴一次，等卡片撑开也不会露在半路。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  /**
   * 发送一句话。`focus` 是这一轮带的项目上下文 —— 默认取屏幕上的当前项目；
   * 「继续处理后续动作」会显式传入**出卡时**的项目，避免切页后续做到别的项目上。
   */
  async function sendText(text: string, focus = projectId): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || pending || disabled) return false;
    setError(null);
    const localId = nextLocalId();
    setMessages((m) => [...m, { role: "user", content: trimmed, localId }]);
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
        });
        return next;
      });
      // 「打开某页」立即生效：多次跳转只认最后一个（前面的还没看就被换掉了没意义）。
      // 面板挂在 layout 里，换页不会把这段对话连同未确认的草案卡一起卸载。
      const navTarget = navigations.at(-1);
      if (navTarget) router.push(navTarget.href);
      // 外壳据此把「懒建出的会话」放进列表；**不**触发 remount，否则刚发的消息会消失
      if (data.conversationId) {
        onTurnPersisted?.({
          conversationId: data.conversationId,
          conversationTitle: data.conversationTitle ?? null,
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
    if (!text || pending || disabled) return;
    setInput("");
    void sendText(text);
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
          return (
            <div key={m.localId ?? m.id ?? `idx-${i}`}>
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
                        ? "正在继续上一轮请求…"
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
                    <div className="-mt-1">{deleteButton}</div>
                  </div>
                  {/* 助手按 Markdown 渲染；用户自己敲的字保持原样，别把 * 和 # 也吃进去 */}
                  <div className="mt-1 text-ink">
                    {m.role === "assistant" ? (
                      <Markdown>{m.content}</Markdown>
                    ) : (
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    )}
                  </div>
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
        {pending && (
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
            <span>{continuingTurn ? "正在处理后续动作…" : "助手正在处理…"}</span>
          </div>
        )}
      </div>
      {error && <p className="shrink-0 text-sm text-high">{error}</p>}
      <div className="flex shrink-0 gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={placeholder}
          className="ac-field flex-1 text-sm"
          disabled={pending || disabled}
        />
        <button onClick={send} disabled={pending || disabled} className="ac-btn px-3 py-2 text-sm">
          {pending ? "思考中…" : "发送"}
        </button>
      </div>
    </section>
  );
}
