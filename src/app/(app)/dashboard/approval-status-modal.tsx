"use client";

import { useEffect } from "react";
import { formatShortDateTime } from "@/lib/time";

/** 状态的视觉口径：学生一眼分清 审批中 / 已通过 / 已驳回 */
const STATUS_VIEW = {
  pending: { icon: "⏳", label: "审批中", tone: "border-medium bg-medium-soft text-medium" },
  approved: { icon: "✓", label: "已通过", tone: "border-done bg-done/10 text-done" },
  rejected: { icon: "✗", label: "已驳回", tone: "border-high bg-high-soft text-high" },
} as const;

/**
 * 任务完成审批状态小窗（学生视角）：看板卡片上的审批徽章点开即见。
 * 内容 = 大状态 + 时间线（何时申请、谁、何时决定）+ 下一步指引。
 */
export function WorkbenchApprovalModal({
  taskTitle,
  status,
  approverName,
  decidedAt,
  requestedAt,
  timeZone,
  onClose,
}: {
  taskTitle: string;
  status: "pending" | "approved" | "rejected";
  approverName?: string | null;
  decidedAt?: Date | null;
  requestedAt?: Date | null;
  timeZone: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const view = STATUS_VIEW[status];

  const hint =
    status === "pending"
      ? "老师或管理员通过后，任务会自动标记为完成；期间任务仍可正常编辑。"
      : status === "rejected"
        ? "任务未被标记完成，可继续推进或修改后重新提交完成申请。"
        : "任务已完成。";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="完成审批情况"
    >
      <div
        className="w-full max-w-md rounded-field border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="min-w-0 truncate font-display text-base font-semibold text-ink" title={taskTitle}>
            完成审批 · {taskTitle}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-1.5 text-lg leading-none text-ink-faint hover:text-ink"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="p-5">
          <div className={`flex items-center gap-2.5 rounded-field border px-4 py-3 ${view.tone}`}>
            <span className="text-xl" aria-hidden>
              {view.icon}
            </span>
            <div>
              <p className="text-sm font-semibold">{view.label}</p>
              {status === "pending" && (
                <p className="mt-0.5 text-xs opacity-80">
                  {requestedAt
                    ? `${formatShortDateTime(timeZone, requestedAt)} 提交`
                    : "等待老师或管理员审批"}
                </p>
              )}
              {status !== "pending" && (
                <p className="mt-0.5 text-xs opacity-80">
                  {approverName ?? "审批人"} · {decidedAt ? formatShortDateTime(timeZone, decidedAt) : ""}
                </p>
              )}
            </div>
          </div>

          <p className="mt-3 text-sm leading-relaxed text-ink-soft">{hint}</p>
        </div>
      </div>
    </div>
  );
}
