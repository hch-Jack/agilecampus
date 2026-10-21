"use client";

import { useEffect, useActionState } from "react";
import {
  resetAssistantHistoryAction,
  type AssistantResetState,
} from "@/app/(app)/settings/actions";
import { ASSISTANT_RESET_EVENT } from "@/lib/agent/assistant-panel-shared";

/**
 * 「AI配置」→「AI 助手」卡片里的聊天记录重置。
 *
 * 破坏性操作沿用全站习惯（`window.confirm`），不另造弹窗。提交成功后派发一个 window 事件：
 * 右侧面板常驻挂载在 layout 里，服务端 props 变了也不会重新播种它的 `useState`，
 * 只能靠事件通知它清空（见 `assistant-shell.tsx`）。
 *
 * 文案要点：只删**自己的个人会话**；项目页的共享对话不受影响；已确认落库的改动不回滚。
 */
export function AssistantHistoryReset({
  conversationCount,
}: {
  /** 当前个人会话数（服务端取，重置后随 revalidate 更新） */
  conversationCount: number;
}) {
  const [state, formAction, pending] = useActionState<AssistantResetState, FormData>(
    resetAssistantHistoryAction,
    null,
  );

  const error = state && "error" in state ? state.error : null;
  const done = state && "ok" in state ? state : null;

  useEffect(() => {
    if (done) window.dispatchEvent(new Event(ASSISTANT_RESET_EVENT));
  }, [done]);

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-ink">聊天记录</h3>
        <p className="mt-0.5 text-xs text-ink-faint">
          当前共有 {conversationCount} 段对话。删除后不可恢复；项目页的共享对话不受影响，
          已确认落库的任务、留言等改动也不会撤销。
        </p>
      </div>

      <form
        action={formAction}
        onSubmit={(e) => {
          if (
            !window.confirm(
              "确定删除你和助手的全部聊天记录吗？项目页的共享对话不受影响；已确认落库的改动不会撤销。此操作不可恢复。",
            )
          ) {
            e.preventDefault();
          }
        }}
      >
        <button
          type="submit"
          disabled={pending || conversationCount === 0}
          className="ac-btn-ghost border-high/40 px-3 py-1.5 text-sm text-high hover:bg-high/10 disabled:opacity-50"
        >
          {pending ? "删除中…" : "删除全部聊天记录"}
        </button>
      </form>

      {error && <p className="text-sm text-high">{error}</p>}
      {!error && done && (
        <p className="text-sm text-ink-soft">
          已删除 {done.deleted} 段对话。
        </p>
      )}
    </section>
  );
}
