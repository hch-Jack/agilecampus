"use client";

import { useActionState } from "react";
import { setHistoryLimitAction, type ContextState } from "@/app/(app)/dashboard/actions";
import { AI_HISTORY_LIMIT_MAX, AI_HISTORY_LIMIT_MIN } from "@/lib/agent/history-limit";

/**
 * 「助手记得多少上文」——工作台助手卡片右上角「设置」里的一行。
 *
 * 这个数是**用户级**的，工作台助手与项目页助手共用同一条（见 lib/agent/memory.ts），
 * 所以界面上的说明必须点明它不只管这一处，否则用户会以为改的只是眼前这个框。
 */

export function AgentHistorySetting({ limit }: { limit: number }) {
  const [state, formAction, pending] = useActionState<ContextState, FormData>(
    setHistoryLimitAction,
    null,
  );
  const error = state && "error" in state ? state.error : null;
  const saved = state && "ok" in state;

  return (
    <section className="space-y-2">
      <div>
        <h3 className="text-sm font-medium text-ink">助手记忆</h3>
        <p className="mt-0.5 text-xs text-ink-faint">
          每轮把最近多少条聊天记录一并交给助手，好让它接着上文说（0 = 不看历史，最多{" "}
          {AI_HISTORY_LIMIT_MAX} 条；一问一答算 2 条）。
          <span className="text-ink-soft">工作台的助手与项目页的助手都按这个数来。</span>
        </p>
      </div>

      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          name="limit"
          min={AI_HISTORY_LIMIT_MIN}
          max={AI_HISTORY_LIMIT_MAX}
          step={1}
          defaultValue={limit}
          className="ac-field w-24 text-sm"
          aria-label="助手可看到的历史消息条数"
        />
        <span className="text-xs text-ink-soft">条</span>
        <button disabled={pending} className="ac-btn px-3 py-1.5 text-sm">
          {pending ? "保存中…" : "保存"}
        </button>
        {error && <span className="text-sm text-high">{error}</span>}
        {!error && saved && <span className="text-sm text-ink-soft">已保存</span>}
      </form>
    </section>
  );
}
