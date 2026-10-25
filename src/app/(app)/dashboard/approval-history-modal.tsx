"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ApprovalHistoryRow } from "@/lib/approval";
import { approvalDetailHref } from "@/lib/approval-view";
import { formatDateTime } from "@/lib/time";
import { listMyApprovalHistoryAction } from "./actions";

const TYPE_LABEL: Record<ApprovalHistoryRow["type"], string> = {
  task_done: "任务完成",
  resource_usage: "资源占用",
};

const STATUS_BADGE: Record<
  ApprovalHistoryRow["status"],
  { text: string; cls: string }
> = {
  pending: { text: "审批中", cls: "bg-medium-soft text-medium" },
  approved: { text: "已通过", cls: "bg-done/10 text-done" },
  rejected: { text: "已驳回", cls: "bg-high-soft text-high" },
};

function HistoryItem({ row, tz }: { row: ApprovalHistoryRow; tz: string }) {
  const href = approvalDetailHref(row);
  const title =
    row.type === "task_done"
      ? row.taskTitle ?? "（任务已删除）"
      : row.resourceName ?? "（未命名资源）";
  const status = STATUS_BADGE[row.status];

  return (
    <li className="rounded-field border border-line bg-surface px-3 py-2">
      <div className="flex items-baseline gap-2">
        {href ? (
          <Link
            href={href}
            className="min-w-0 flex-1 truncate text-sm font-medium text-ink hover:text-primary"
            title={title}
          >
            {title}
          </Link>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink" title={title}>
            {title}
          </span>
        )}
        <span className={`ac-badge shrink-0 ${status.cls}`}>{status.text}</span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-ink-faint">
        {TYPE_LABEL[row.type]} · {row.teamName} · {row.requesterName} 申请 ·{" "}
        {formatDateTime(tz, row.createdAt)}
      </p>
      {row.purpose && <p className="truncate text-[11px] text-ink-soft">用途：{row.purpose}</p>}
      {row.decisionNote && (
        <p className="mt-1 whitespace-pre-wrap break-words rounded-field bg-sunken px-2 py-1 text-[11px] leading-relaxed text-ink-soft">
          审批回复：{row.decisionNote}
        </p>
      )}
      {row.approverName && row.decidedAt && (
        <p className="mt-0.5 text-[11px] text-ink-faint">
          {row.approverName} 于 {formatDateTime(tz, row.decidedAt)} 处理
        </p>
      )}
    </li>
  );
}

function Section({
  title,
  rows,
  tz,
  empty,
}: {
  title: string;
  rows: ApprovalHistoryRow[];
  tz: string;
  empty: string;
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-ink-soft">
        {title}
        <span className="ac-badge bg-sunken text-ink-faint">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-ink-faint">{empty}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <HistoryItem key={r.id} row={r} tz={tz} />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 工作台看板右上角「审批记录」弹窗：把与我有关的审批都列出来 ——
 * 我发起过的（等结果 / 已通过 / 已驳回）与由我审批过的，
 * 每条带审批状态、审批人回复（拒绝原因）和回到任务/资源的入口。
 * 打开时现拉一次（不做轮询，关掉重开即可刷新）。
 */
export function ApprovalHistoryModal({
  timeZone,
  onClose,
}: {
  timeZone: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ApprovalHistoryRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await listMyApprovalHistoryAction();
      if (cancelled) return;
      if ("error" in r) setError(r.error);
      else setRows(r.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const requested = rows?.filter((r) => r.direction === "requested") ?? [];
  const decided = rows?.filter((r) => r.direction === "decided") ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="审批记录"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-field border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="text-sm font-semibold text-ink">审批记录</span>
          {rows && <span className="ac-badge bg-sunken text-ink-faint">{rows.length}</span>}
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-1.5 text-lg leading-none text-ink-faint hover:text-ink"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {error && <p className="text-sm text-high">{error}</p>}
          {!rows && !error && <p className="text-sm text-ink-faint">加载中…</p>}
          {rows && rows.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-faint">还没有审批记录</p>
          )}
          {rows && rows.length > 0 && (
            <>
              <Section
                title="我发起的"
                rows={requested}
                tz={timeZone}
                empty="你还没有发起过申请"
              />
              <Section
                title="我审批的"
                rows={decided}
                tz={timeZone}
                empty="还没有由你处理的申请"
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
