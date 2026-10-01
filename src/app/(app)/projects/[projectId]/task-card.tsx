"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { useDraggable } from "@dnd-kit/core";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";
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
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
    disabled: !canWrite,
  });

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
      style={
        transform
          ? { transform: `translate(${transform.x}px, ${transform.y}px)` }
          : undefined
      }
      className={`ac-card p-3 text-sm transition hover:shadow-md ${isDragging ? "opacity-50" : ""}`}
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
          className="font-medium text-ink hover:text-primary"
        >
          {task.title}
        </Link>
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-soft">
          <span>{task.assigneeName ?? "未分配"}</span>
          {(task.startDate || task.dueDate) && (
            <span>· {task.startDate ?? "…"}→{task.dueDate ?? "…"}</span>
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
        {task.status === "done" && task.completionNote && (
          <p className="mt-1 rounded bg-done/10 px-2 py-1 text-xs text-done">
            完成情况：{task.completionNote}
          </p>
        )}
      </div>
    </div>
  );
}
