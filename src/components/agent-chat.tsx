"use client";

import { useState } from "react";
import { DraftCards, type ChatScope, type Draft, type OptionMap } from "@/components/draft-cards";

/**
 * AI 助手对话框 —— 项目页（`scope="project"`）与工作台（`scope="personal"`）共用。
 *
 * 两处打的是同一个 `/api/chat`，差别只在请求体：项目页带 projectId，工作台带 scope。
 * 个人回合的响应会额外带 `options`（草案可能指向多个项目），故按消息随行保存 ——
 * 楼上楼下两条消息的草案可以指向不同项目。
 */

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  drafts?: Draft[];
  options?: OptionMap;
};

export function AgentChat({
  scope,
  projectId,
  initialMessages,
  defaultOptions,
  title = "项目助手",
  emptyHint = "向助手提问，如「当前进度如何？」或「把调研拆成任务」",
  placeholder = "问点什么…",
}: {
  scope: ChatScope;
  /** 项目 scope 必填；个人 scope 的 projectId 由助手按草案自己填 */
  projectId?: string;
  initialMessages: ChatMessage[];
  /** 项目页预先算好的一种选项；个人页留空，由响应带回 */
  defaultOptions?: OptionMap;
  title?: string;
  emptyHint?: string;
  placeholder?: string;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const text = input.trim();
    if (!text || pending) return;
    setInput("");
    setError(null);
    setMessages((m) => [...m, { role: "user", content: text }]);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "personal" ? { scope, userText: text } : { scope, projectId, userText: text },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "对话失败");
        return;
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.text, drafts: data.drafts, options: data.options },
      ]);
    } catch {
      setError("网络异常，请重试");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="ac-card space-y-3 p-4">
      <h2 className="font-medium text-ink">{title}</h2>
      <div className="max-h-96 space-y-2 overflow-y-auto">
        {messages.map((m, i) => (
          <div key={i}>
            <div className={`rounded-lg p-2.5 text-sm ${m.role === "user" ? "bg-sunken" : "bg-primary-soft"}`}>
              <span className="mr-2 text-xs text-ink-faint">{m.role === "user" ? "我" : "助手"}</span>
              <span className="whitespace-pre-wrap text-ink">{m.content}</span>
            </div>
            {m.drafts && m.drafts.length > 0 && (
              <DraftCards
                drafts={m.drafts}
                options={m.options ?? defaultOptions ?? {}}
                defaultProjectId={projectId}
                scope={scope}
              />
            )}
          </div>
        ))}
        {messages.length === 0 && <p className="text-sm text-ink-soft">{emptyHint}</p>}
      </div>
      {error && <p className="text-sm text-high">{error}</p>}
      <div className="flex gap-2">
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
