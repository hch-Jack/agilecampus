"use client";

import { useEffect, useState } from "react";
import { DECISION_NOTE_MAX_LENGTH } from "@/lib/approval-view";

/**
 * 拒绝原因对话框：审批人点「拒绝」时先问一句为什么（可留空）。
 * 老师/管理员在待办审批卡、系统消息、审批详情三处共用；
 * 原因会随回执系统消息发给申请人，并出现在审批详情里。
 */
export function RejectReasonDialog({
  subject,
  busy = false,
  error,
  onCancel,
  onConfirm,
}: {
  /** 被拒绝的对象（任务标题 / 资源名），让审批人确认没点错行 */
  subject: string;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={() => !busy && onCancel()}
      role="dialog"
      aria-modal="true"
      aria-label="填写拒绝原因"
    >
      <div
        className="w-full max-w-md rounded-field border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) onConfirm(note.trim());
          }}
          className="p-5"
        >
          <h2 className="font-display text-base font-semibold text-ink">拒绝申请</h2>
          <p className="mt-1.5 truncate text-sm text-ink-soft" title={subject}>
            {subject}
          </p>
          <label className="mt-3 block text-xs font-medium text-ink-soft" htmlFor="reject-note">
            拒绝原因（选填，会通过系统消息发给申请人）
          </label>
          <textarea
            id="reject-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={DECISION_NOTE_MAX_LENGTH}
            rows={3}
            autoFocus
            placeholder="例如：完成情况写得太简略，请补充截图后再提交"
            className="ac-field mt-1 w-full resize-none text-sm"
            disabled={busy}
          />
          <p className="mt-1 text-right text-[11px] text-ink-faint tabular-nums">
            {note.length}/{DECISION_NOTE_MAX_LENGTH}
          </p>
          {error && <p className="mt-1 text-sm text-high">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="ac-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy}
              className="ac-btn bg-high px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy ? "提交中…" : "确认拒绝"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
