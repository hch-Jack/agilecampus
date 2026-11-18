"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDraggable } from "@dnd-kit/core";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";
import { SubtaskProgress } from "@/components/subtask-progress";
import { RejectReasonDialog } from "@/components/reject-reason-dialog";
import { ACTIVITY_NEW_EVENT } from "@/components/activity-feed";
import { decideApprovalAction } from "@/app/(app)/dashboard/actions";
import type { BoardTask } from "./board";

const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-high-soft text-high",
  medium: "bg-medium-soft text-medium",
  low: "bg-low-soft text-low",
};

export function TaskCard({
  task,
  projectId,
  canWrite,
}: {
  task: BoardTask;
  projectId: string;
  canWrite: boolean;
}) {
  // 拖拽浮层由看板 DragOverlay 渲染，这里不再应用 transform：卡片原位留下低透明幽灵
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !canWrite,
  });
  const router = useRouter();
  const [approvalPending, startTransition] = useTransition();
  const [approvalError, setApprovalError] = useState("");
  const [rejecting, setRejecting] = useState(false);

  // 有 task_done 审批权者可直接在待审批卡片上决定；权限与「不能批自己」由服务端再校验
  function decide(decision: "approved" | "rejected", note?: string) {
    const pendingApproval = task.pendingApproval;
    if (!pendingApproval) return;
    startTransition(async () => {
      setApprovalError("");
      const res = await decideApprovalAction({
        requestId: pendingApproval.requestId,
        decision,
        note,
      });
      if ("error" in res) {
        setApprovalError(res.error);
        return;
      }
      setRejecting(false);
      // 与拖拽成功同口径：动态流立即 +1，随后整页回流带出任务新列
      window.dispatchEvent(
        new CustomEvent<string>(ACTIVITY_NEW_EVENT, { detail: `project:${projectId}` }),
      );
      router.refresh();
    });
  }

  // 标题链去详情页，但拖拽结束浏览器会补发一次 click，须拦下避免误导航
  const suppressClickRef = useRef(false);
  useEffect(() => {
    if (isDragging) {
      suppressClickRef.current = true;
    } else {
      // 定时器在补发 click 之后才跑，拖后一次真点击不受影响
      const t = setTimeout(() => (suppressClickRef.current = false), 0);
      return () => clearTimeout(t);
    }
  }, [isDragging]);

  return (
    <div
      ref={setNodeRef}
      data-task-card-id={task.id}
      onMouseMove={(e) => {
        const el = e.currentTarget;
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left;
        const y = e.clientY - r.top;
        el.style.setProperty("--mx", `${x}px`);
        el.style.setProperty("--my", `${y}px`);
        el.style.setProperty("--ry", `${((x / r.width - 0.5) * 6).toFixed(2)}deg`);
        el.style.setProperty("--rx", `${(-(y / r.height - 0.5) * 6).toFixed(2)}deg`);
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.setProperty("--rx", "0deg");
        e.currentTarget.style.setProperty("--ry", "0deg");
      }}
      className={`ac-card proj-card relative p-3 text-sm transition ${
        isDragging ? "dragging" : ""
      }`}
    >
      <div
        {...listeners}
        {...attributes}
        className={canWrite ? "cursor-grab" : ""}
      >
        <Link
          href={`/projects/${projectId}/tasks/${task.id}`}
          onClick={(e) => {
            if (suppressClickRef.current) {
              e.preventDefault();
              suppressClickRef.current = false;
            }
          }}
          // card-link 把可点区域铺满整张卡；可拖拽时保留抓手光标
          className={`card-link font-medium text-ink hover:text-primary ${
            canWrite ? "cursor-grab" : "cursor-pointer"
          }`}
        >
          {task.title}
        </Link>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
          <span>{task.assigneeName ?? "未分配"}</span>
          {(task.startDate || task.dueDate) && (
            <span>· {task.startDate ?? "…"}→{task.dueDate ?? "…"}</span>
          )}
          {task.pendingApproval && (
            <span className="ac-badge bg-medium-soft text-medium">待审批</span>
          )}
          <span className={`ac-badge ${PRIORITY_BADGE[task.priority] ?? "bg-low-soft text-low"}`}>
            {task.priority}
          </span>
        </p>
        {task.labels.length > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1">
            {task.labels.slice(0, 3).map((l) => (
              <span
                key={l.id}
                className={`ac-badge ${LABEL_COLOR_CLASS[l.color] ?? LABEL_COLOR_CLASS.slate}`}
              >
                {l.name}
              </span>
            ))}
            {task.labels.length > 3 && (
              <span className="text-xs text-ink-faint">+{task.labels.length - 3}</span>
            )}
          </p>
        )}
        {task.description && (
          <p className="mt-1 text-xs text-ink-soft line-clamp-2">{task.description}</p>
        )}
        {(task.status === "done" || task.pendingApproval) && task.completionNote && (
          <p className="mt-1 rounded bg-done/10 px-2 py-1 text-xs text-done">
            完成情况：{task.completionNote}
          </p>
        )}
        <SubtaskProgress total={task.subTotal ?? 0} done={task.subDone ?? 0} />
      </div>

      {/* 审批操作放在拖拽监听区之外：点按钮不会启动拖拽 */}
      {task.pendingApproval?.canDecide && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="flex gap-1.5">
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              disabled={approvalPending}
              onClick={() => decide("approved")}
              className="ac-btn px-2.5 py-1 text-xs disabled:opacity-50"
            >
              通过
            </button>
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              disabled={approvalPending}
              onClick={() => {
                setApprovalError("");
                setRejecting(true);
              }}
              className="ac-btn-ghost px-2.5 py-1 text-xs disabled:opacity-50"
            >
              拒绝
            </button>
          </div>
          {approvalError && <p className="mt-1 text-xs text-high">{approvalError}</p>}
          {rejecting && (
            <RejectReasonDialog
              subject={task.title}
              busy={approvalPending}
              error={approvalError}
              onCancel={() => setRejecting(false)}
              onConfirm={(note) => decide("rejected", note)}
            />
          )}
        </div>
      )}
    </div>
  );
}
