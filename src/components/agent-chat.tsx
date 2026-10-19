"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DraftCards, type ChatScope, type Draft, type OptionMap } from "@/components/draft-cards";

/**
 * AI 助手对话框 —— 项目页（`scope="project"`）与工作台（`scope="personal"`）共用。
 *
 * 两处打的是同一个 `/api/chat`，差别只在请求体：项目页带 projectId，工作台带 scope。
 * 个人回合的响应会额外带 `options`（草案可能指向多个项目），故按消息随行保存 ——
 * 楼上楼下两条消息的草案可以指向不同项目。
 *
 * `settings` 是可选的：给了就在标题栏右侧长出「设置」按钮，点开把这块内容收进卡片里
 * （工作台拿它装「我的个人上下文」）。项目页不传，于是没有按钮、行为逐字不变。
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
  settings,
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
  /** 有值才显示右上角「设置」按钮，点开即在此卡片内展开这块内容 */
  settings?: ReactNode;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // 消息区是定高可滚动的（max-h-96）：不主动贴底的话，刚发出的那句、以及随后落下来的
  // 答复（还带一叠草案卡）全长在视野下方，得手动往下拖才看得见 —— 看上去像「没反应」。
  // 这里读 scrollHeight 会强制一次布局，故同一次提交里渲染出来的草案卡高度也算在内。
  // 依赖里带上 pending：从「思考中…」转回结果时再贴一次，等卡片撑开也不会露在半路。
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  /**
   * 发送一句话。抽出来是为了让「继续处理后续动作」按钮也能走同一条链路 ——
   * 返回是否成功，卡片据此决定要不要恢复按钮。
   */
  async function sendText(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || pending) return false;
    setError(null);
    setMessages((m) => [...m, { role: "user", content: trimmed }]);
    setPending(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          scope === "personal"
            ? { scope, userText: trimmed }
            : { scope, projectId, userText: trimmed },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "对话失败");
        return false;
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.text, drafts: data.drafts, options: data.options },
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
    <section className="ac-card space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-medium text-ink">{title}</h2>
        {settings && (
          <button
            type="button"
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
            aria-controls="agent-chat-settings"
            className={`ac-btn-ghost ${
              showSettings ? "border-primary bg-primary-soft text-primary" : ""
            }`}
          >
            {showSettings ? "收起设置" : "设置"}
          </button>
        )}
      </div>

      {settings && showSettings && (
        <div
          id="agent-chat-settings"
          className="max-h-80 overflow-y-auto rounded-lg border border-line bg-sunken p-3"
        >
          {settings}
        </div>
      )}

      <div ref={listRef} className="max-h-96 space-y-2 overflow-y-auto">
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
                // 「继续」要复述用户最初那句话；助手消息前一条正是它
                originalText={
                  i > 0 && messages[i - 1].role === "user" ? messages[i - 1].content : ""
                }
                busy={pending}
                onContinue={sendText}
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
