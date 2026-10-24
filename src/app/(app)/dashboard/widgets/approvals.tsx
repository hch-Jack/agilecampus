"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { DashboardApproval } from "../dashboard-types";
import { WidgetEmpty, WidgetShell } from "./shell";
import { decideApprovalAction } from "../actions";
import { approvalDetailHref } from "@/lib/approval-view";
import { formatDateTime } from "@/lib/time";

// 申请单上的一行：类型角标 + 对象标题（链详情）+ 申请人/团队/时间 + 通过/拒绝
function ApprovalRow({ row, tz }: { row: DashboardApproval; tz: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");

  function decide(decision: "approved" | "rejected") {
    startTransition(async () => {
      setError("");
      const res = await decideApprovalAction({ requestId: row.id, decision });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // 服务端 revalidate 已把决定落定，整页回流刷新卡片列表与看板角标
      router.refresh();
    });
  }

  const href = approvalDetailHref(row);

  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        {href ? (
          <Link
            href={href}
            className="truncate text-sm font-medium text-ink hover:text-primary"
            title={row.taskTitle ?? row.resourceName ?? ""}
          >
            {row.type === "task_done" ? row.taskTitle : row.resourceName}
          </Link>
        ) : (
          <span className="truncate text-sm font-medium text-ink">
            {row.type === "task_done" ? row.taskTitle : row.resourceName}
          </span>
        )}
        <span
          className={`ac-badge shrink-0 ${
            row.type === "task_done" ? "bg-doing/10 text-doing" : "bg-accent-soft text-accent"
          }`}
        >
          {row.type === "task_done" ? "任务完成" : "资源占用"}
        </span>
      </div>
      <p className="mt-0.5 truncate text-[11px] text-ink-faint">
        {row.requesterName} · {row.teamName} · {formatDateTime(tz, row.createdAt)}
      </p>
      {row.type === "resource_usage" && row.purpose && (
        <p className="truncate text-[11px] text-ink-soft">用途：{row.purpose}</p>
      )}
      {error && <p className="mt-1 text-xs text-high">{error}</p>}
      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("approved")}
          className="ac-btn px-2.5 py-1 text-xs disabled:opacity-50"
        >
          通过
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => decide("rejected")}
          className="ac-btn-ghost px-2.5 py-1 text-xs disabled:opacity-50"
        >
          拒绝
        </button>
      </div>
    </li>
  );
}

/** 老师/管理员的「待办审批」卡：列出所在团队里待处理的任务完成与资源占用申请 */
export function ApprovalsWidget({
  approvals,
  tz,
}: {
  approvals: DashboardApproval[];
  tz: string;
}) {
  return (
    <WidgetShell title="待办审批">
      {approvals.length === 0 ? (
        <WidgetEmpty>暂无待审批的申请</WidgetEmpty>
      ) : (
        <ul className="space-y-2.5">
          {approvals.map((row) => (
            <ApprovalRow key={row.id} row={row} tz={tz} />
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
