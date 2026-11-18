"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * AI 助手记忆的导入 / 导出。导出的是一个 JSON 快照：
 * 个人上下文 + 个人会话的消息记录 + 「记得多少上文」偏好（仅作记录）。
 *
 * 导入只**补**不回滚：上下文按正文去重、受每人 50 条配额约束；对话一律新建，
 * 不会覆盖现有记录，也不会改掉本机的「记得多少上文」设置。
 */

/** 与服务端 MEMORY_IMPORT_MAX_BYTES 一致；客户端先挡一次，省得白传 5MB */
const MAX_BYTES = 5 * 1024 * 1024;

export function AssistantMemoryTransfer({
  contextCount,
  conversationCount,
}: {
  contextCount: number;
  conversationCount: number;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function importFile(file: File | undefined) {
    if (!file) return;
    setNotice(null);
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("记忆文件不能超过 5MB");
      return;
    }

    setBusy(true);
    try {
      const text = await file.text();
      const res = await fetch("/api/assistant/memory/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: text,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "导入失败，请检查文件");
        return;
      }
      const skipped = Number(data.contextsSkipped) || 0;
      setNotice(
        `已导入 ${Number(data.contextsAdded) || 0} 条个人上下文、${
          Number(data.conversationsAdded) || 0
        } 段对话（${Number(data.messagesAdded) || 0} 条消息）` +
          (skipped > 0 ? `；${skipped} 条上下文因重复或超出上限被跳过` : ""),
      );
      // 设置页的上下文列表与数量重新取一遍
      router.refresh();
    } catch {
      setError("网络异常，请重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ink">记忆导入 / 导出</h3>
        <p className="mt-0.5 text-xs text-ink-faint">
          导出一个 JSON 快照，包含你的个人上下文（当前 {contextCount} 条）与助手的对话记录（当前{" "}
          {conversationCount} 段，每段最多导出最近 500 条消息）。导入会把文件里的内容补进你的账号：
          上下文按正文去重（受 50 条上限约束），对话一律新建，不会覆盖现有记录。
          「记得多少上文」的设置不随导入改动。
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a href="/api/assistant/memory/export" className="ac-btn text-sm">
          导出记忆
        </a>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="ac-btn-ghost text-sm"
        >
          {busy ? "导入中…" : "导入记忆"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            void importFile(e.target.files?.[0]);
            // 允许连续导入同一个文件
            e.target.value = "";
          }}
        />
      </div>

      {notice && <p className="text-xs text-done">{notice}</p>}
      {error && <p className="text-xs text-high">{error}</p>}
    </section>
  );
}
