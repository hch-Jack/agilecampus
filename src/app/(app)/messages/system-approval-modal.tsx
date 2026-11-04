"use client";

import { useEffect, useState, useTransition } from "react";
import { FilePreviewModal } from "@/components/file-preview";
import { RejectReasonDialog } from "@/components/reject-reason-dialog";
import { decideApprovalAction } from "@/app/(app)/dashboard/actions";
import type { ApprovalDetail } from "@/lib/approval";
import { approvalSubject } from "@/lib/approval-view";
import { formatDateTime } from "@/lib/time";
import { getApprovalDetailAction } from "./actions";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 审批详情小窗（消息页「系统消息」点「查看详情」打开）：
 * 任务完成申请 → 学生填的完成情况 + 附件（点击可在线预览）；
 * 资源占用申请 → 资源/用途/起止时间。审批人可就地通过/拒绝（不看也能直接批）。
 */
export function SystemApprovalModal({
  approvalId,
  canDecide,
  timeZone,
  onClose,
  onDecided,
}: {
  approvalId: string;
  canDecide: boolean;
  timeZone: string;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [detail, setDetail] = useState<ApprovalDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [previewFile, setPreviewFile] = useState<
    { url: string; filename: string; mimeType: string | null; size: number } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getApprovalDetailAction(approvalId);
      if (cancelled) return;
      if (r.ok) setDetail(r.data);
      else setError(r.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [approvalId]);

  function decide(decision: "approved" | "rejected", note?: string) {
    startTransition(async () => {
      setError("");
      const r = await decideApprovalAction({ requestId: approvalId, decision, note });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setRejecting(false);
      onDecided();
    });
  }

  /** 拒绝原因对话框的抬头：优先用已加载的详情，未加载完再退回通用文案 */
  const rejectSubject = detail
    ? approvalSubject({
        type: detail.type,
        taskTitle: detail.taskTitle,
        resourceName: detail.resourceName,
        projectName: detail.projectName,
      }) || "该申请"
    : "该申请";

  const statusBadge =
    detail?.status === "approved" ? (
      <span className="ac-badge bg-done/10 text-done">已通过</span>
    ) : detail?.status === "rejected" ? (
      <span className="ac-badge bg-high-soft text-high">已驳回</span>
    ) : (
      <span className="ac-badge bg-medium-soft text-medium">审批中</span>
    );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="审批详情"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-field border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-sm font-semibold text-ink">审批详情</span>
          {detail && statusBadge}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-1.5 text-lg leading-none text-ink-faint hover:text-ink"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {error && <p className="text-sm text-high">{error}</p>}
          {!detail && !error && <p className="text-sm text-ink-faint">加载中…</p>}
          {detail && (
            <div className="space-y-3 text-sm">
              <p className="text-ink-soft">
                申请人：<span className="font-medium text-ink">{detail.requesterName}</span>
                {detail.decidedAt && detail.approverName && (
                  <span className="text-ink-faint">
                    {" "}
                    · 由 {detail.approverName} 于 {formatDateTime(timeZone, detail.decidedAt)} 决定
                  </span>
                )}
              </p>

              {detail.decisionNote && (
                <div>
                  <p className="text-xs font-medium text-ink-soft">拒绝原因（审批人填写）</p>
                  <p className="mt-1 whitespace-pre-wrap break-words rounded-field border border-line bg-sunken p-3 text-xs leading-relaxed text-ink">
                    {detail.decisionNote}
                  </p>
                </div>
              )}

              {detail.type === "project_acceptance" ? (
                <div className="space-y-1.5 text-ink-soft">
                  <p>
                    项目：<span className="font-medium text-ink">{detail.projectName}</span>
                  </p>
                  <div>
                    <p className="text-xs font-medium text-ink-soft">结题说明（申请人填写）</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded-field border border-line bg-sunken p-3 font-sans text-xs leading-relaxed text-ink">
                      {detail.purpose || "（未填写）"}
                    </pre>
                  </div>
                  <p className="text-xs text-ink-faint">通过后项目将标记为「已结题」并退出工作台统计。</p>
                </div>
              ) : detail.type === "task_done" ? (
                <>
                  <p className="text-ink-soft">
                    任务：<span className="font-medium text-ink">{detail.taskTitle}</span>
                  </p>
                  <div>
                    <p className="text-xs font-medium text-ink-soft">完成情况（学生填写）</p>
                    <pre className="mt-1 whitespace-pre-wrap break-words rounded-field border border-line bg-sunken p-3 font-sans text-xs leading-relaxed text-ink">
                      {detail.completionNote || "（未填写）"}
                    </pre>
                  </div>
                  <div>
                    <p className="text-xs font-medium text-ink-soft">
                      附件（{detail.attachments.length}，点击在线预览）
                    </p>
                    {detail.attachments.length === 0 ? (
                      <p className="mt-1 text-xs text-ink-faint">没有附件</p>
                    ) : (
                      <ul className="mt-1 space-y-1">
                        {detail.attachments.map((a) => (
                          <li key={a.id}>
                            <button
                              type="button"
                              onClick={() =>
                                setPreviewFile({
                                  url: `/api/attachments/${a.id}`,
                                  filename: a.filename,
                                  mimeType: a.mimeType,
                                  size: a.size,
                                })
                              }
                              className="flex w-full items-center gap-1.5 rounded-field px-2 py-1 text-left text-xs text-primary hover:bg-sunken"
                            >
                              <span aria-hidden>📄</span>
                              <span className="min-w-0 flex-1 truncate">{a.filename}</span>
                              <span className="shrink-0 text-ink-faint">{fmtSize(a.size)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              ) : (
                <div className="space-y-1.5 text-ink-soft">
                  <p>
                    资源：<span className="font-medium text-ink">{detail.resourceName}</span>
                  </p>
                  {detail.purpose && (
                    <p>
                      用途：<span className="text-ink">{detail.purpose}</span>
                    </p>
                  )}
                  {detail.startTime && (
                    <p>
                      开始：{formatDateTime(timeZone, detail.startTime)}
                    </p>
                  )}
                  {detail.endTime && <p>结束：{formatDateTime(timeZone, detail.endTime)}</p>}
                  {!detail.endTime && <p>结束：占用中（通过后记为持续占用）</p>}
                </div>
              )}

              {error && <p className="text-xs text-high">{error}</p>}

              {canDecide && detail.status === "pending" && (
                <div className="flex justify-end gap-2 border-t border-line pt-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setError("");
                      setRejecting(true);
                    }}
                    className="ac-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    拒绝
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => decide("approved")}
                    className="ac-btn px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    通过
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {previewFile && (
          <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
        )}

        {rejecting && (
          <RejectReasonDialog
            subject={rejectSubject}
            busy={busy}
            error={error}
            onCancel={() => setRejecting(false)}
            onConfirm={(note) => decide("rejected", note)}
          />
        )}
      </div>
    </div>
  );
}
