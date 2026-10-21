"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DraftCards, type ChatScope, type Draft, type OptionMap } from "@/components/draft-cards";

/**
 * AI 助手对话区 —— 右侧常驻面板（`assistant-shell.tsx`）的唯一使用者。
 *
 * 打的是 `/api/chat` 的**个人** scope：会话每人一条、只属于本人。在项目页面里，外壳把当前
 * 项目 id 作为 `projectId` 传进来；后端把它当「焦点项目」——只影响这一轮的快照与工具面，
 * **不改变会话归属**（见 lib/agent/orchestrator.ts）。
 *
 * 个人回合的响应会额外带 `options`（草案可能指向多个项目），故按消息随行保存：上下两条消息的
 * 草案可以指向不同项目。每条助手消息还记下**那一轮用的焦点项目**，用户切到另一个项目后点
 * 「继续处理后续动作」，仍按出卡时的项目续做，而不是跟着屏幕走。
 *
 * 布局是满高的：外层（壳）负责宽度与背景，这里只负责「标题行 + 可滚消息区 + 输入行」。
 */

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  drafts?: Draft[];
  options?: OptionMap;
  /** 生成这条答复时带的焦点项目；续做沿用它，而不是屏幕当前项目 */
  focusProjectId?: string;
};

export function AgentChat({
  scope,
  projectId,
  initialMessages,
  title = "AI 助手",
  subtitle,
  emptyHint = "向助手提问，如「当前进度如何？」或「把调研拆成任务」",
  placeholder = "问点什么…",
  actions,
}: {
  scope: ChatScope;
  /** 当前页面所在项目；有值时后端把它当焦点项目（会话仍是个人会话） */
  projectId?: string;
  initialMessages: ChatMessage[];
  title?: string;
  subtitle?: string;
  emptyHint?: string;
  placeholder?: string;
  /** 标题行右侧的按钮（设置链接、收起按钮） */
  actions?: ReactNode;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

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
    if (!trimmed || pending) return false;
    setError(null);
    setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // focus 为 undefined 时 JSON 里不会出现 projectId 键，后端按「没有当前项目」处理
        body: JSON.stringify({ scope, projectId: focus, userText: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "对话失败");
        return false;
      }
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: data.text,
          drafts: data.drafts,
          options: data.options,
          focusProjectId: focus,
        },
      ]);
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
    if (!text || pending) return;
    setInput("");
    void sendText(text);
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="font-medium text-ink">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-ink-faint">{subtitle}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>

      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {messages.map((m, i) => (
          <div key={i}>
            <div className={`rounded-lg p-2.5 text-sm ${m.role === "user" ? "bg-sunken" : "bg-primary-soft"}`}>
              <span className="mr-2 text-xs text-ink-faint">{m.role === "user" ? "我" : "助手"}</span>
              <span className="whitespace-pre-wrap text-ink">{m.content}</span>
            </div>
            {m.drafts && m.drafts.length > 0 && (
              <DraftCards
                drafts={m.drafts}
                options={m.options ?? {}}
                // 草案卡的项目下拉随这一轮走，而不是随当前页面走
                defaultProjectId={m.focusProjectId ?? projectId}
                scope={scope}
                // 「继续」要复述用户最初那句话；助手消息前一条正是它
                originalText={
                  i > 0 && messages[i - 1].role === "user" ? messages[i - 1].content : ""
                }
                busy={pending}
                onContinue={(text) => sendText(text, m.focusProjectId)}
              />
            )}
          </div>
        ))}
        {messages.length === 0 && <p className="text-sm text-ink-soft">{emptyHint}</p>}
      </div>
      {error && <p className="shrink-0 text-sm text-high">{error}</p>}
      <div className="flex shrink-0 gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={placeholder}
          className="ac-field flex-1 text-sm"
          disabled={pending}
        />
        <button onClick={send} disabled={pending} className="ac-btn px-3 py-2 text-sm">
          {pending ? "思考中…" : "发送"}
        </button>
      </div>
    </section>
  );
}
