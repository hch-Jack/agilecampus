"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  completeProjectAction,
  reopenProjectAction,
  requestProjectAcceptanceAction,
} from "./actions";

/**
 * 项目结题验收控件（项目页头部）。
 * 有验收权（admin 或被勾选者）：进行中的项目可直接结题（confirm 后落库），
 * 已结题的项目可恢复进行中（任务保持已完成状态）；
 * 无权成员：可填结题说明发起申请，待有权限者在工作台/消息页审批。
 * 已有 pending 申请时不渲染任何按钮，状态由头部徽章呈现。
 */
export function AcceptanceControl({
  projectId,
  projectName,
  status,
  pendingAcceptance,
  canAccept,
}: {
  projectId: string;
  projectName: string;
  status: "active" | "completed" | "archived";
  pendingAcceptance: boolean;
  canAccept: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const [applying, setApplying] = useState(false);
  const [note, setNote] = useState("");

  if (status === "archived" || pendingAcceptance) return null;

  // 已结题：有验收权者可恢复进行中，任务保持已完成状态
  if (status === "completed") {
    if (!canAccept) return null;
    return (
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const text =
              `确认将「${projectName}」恢复为进行中？\n\n` +
              "项目将重新回到进行中状态，工作台恢复统计其任务；任务状态保持不变。";
            if (!confirm(text)) return;
            startTransition(async () => {
              setError("");
              const res = await reopenProjectAction({ projectId });
              if ("error" in res) {
                setError(res.error);
                return;
              }
              router.refresh();
            });
          }}
          className="ac-btn-ghost whitespace-nowrap"
        >
          {pending ? "处理中…" : "恢复进行中"}
        </button>
        {error && <span className="text-xs text-high">{error}</span>}
      </div>
    );
  }

  function completeDirectly() {
    const text =
      `确认将「${projectName}」直接标记为已结题？\n\n` +
      "项目将退出进行中状态，工作台不再统计其任务；未决的结题申请（若有）一并作废。";
    if (!confirm(text)) return;
    startTransition(async () => {
      setError("");
      const res = await completeProjectAction({ projectId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  }

  function apply() {
    startTransition(async () => {
      setError("");
      const res = await requestProjectAcceptanceAction({ projectId, note });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setApplying(false);
      router.refresh();
    });
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {canAccept ? (
        <button
          type="button"
          onClick={completeDirectly}
          disabled={pending}
          className="ac-btn whitespace-nowrap px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {pending ? "处理中…" : "直接结题"}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setApplying(true)}
          className="ac-btn-ghost whitespace-nowrap"
        >
          申请结题验收
        </button>
      )}
      {error && <span className="text-xs text-high">{error}</span>}

      {applying && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !pending && setApplying(false)}
          role="dialog"
          aria-modal="true"
          aria-label="申请结题验收"
        >
          <div
            className="w-full max-w-lg rounded-field border border-line bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5">
              <h2 className="font-display text-base font-semibold text-ink">
                申请结题验收
                <span className="ml-1.5 text-xs font-normal text-ink-faint">{projectName}</span>
              </h2>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">
                项目须在<strong className="text-ink">全部任务完成后</strong>
                才能申请；提交后由拥有「审核项目结题验收」权限的成员审批，通过后项目标记为已结题。
              </p>
              <label className="mt-3 block space-y-1">
                <span className="text-xs font-medium text-ink-soft">结题说明（可选）</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="成果、遗留问题、后续计划……"
                  className="w-full resize-none rounded-field border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                  aria-label="结题说明"
                />
              </label>
              {error && <p className="mt-2 text-sm text-high">{error}</p>}
              <div className="mt-4 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setApplying(false)}
                  disabled={pending}
                  className="ac-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={apply}
                  disabled={pending}
                  className="ac-btn px-3 py-1.5 text-sm disabled:opacity-50"
                >
                  {pending ? "提交中…" : "提交申请"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
