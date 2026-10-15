"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { deriveColumns, type BoardColumn, type ColumnPatch } from "@/lib/board-columns";
import type { GroupBy } from "@/lib/board-filters";
import { moveTaskAction } from "./actions";
import { TaskCard } from "./task-card";
import { ACTIVITY_NEW_EVENT } from "@/components/activity-feed";

export type Option = { id: string; name: string };

export type BoardTask = {
  id: string;
  title: string;
  description: string | null;
  completionNote: string | null;
  status: "todo" | "doing" | "done";
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  assigneeName: string | null;
  assigneeId: string | null;
  milestoneId: string | null;
  labels: { id: string; name: string; color: string }[];
};

function Column({
  column,
  tasks,
  projectId,
  canWrite,
}: {
  column: BoardColumn;
  tasks: BoardTask[];
  projectId: string;
  canWrite: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });

  return (
    <div
      ref={setNodeRef}
      className={`proj-column min-h-40 w-72 shrink-0 space-y-2 rounded-xl border border-line p-3 transition-colors ${
        isOver ? "drop" : ""
      }`}
    >
      <h3 className={`flex items-center gap-2 text-sm font-semibold ${column.tone}`}>
        {column.label}
        <span className="ac-badge bg-surface text-ink-soft">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <TaskCard key={t.id} task={t} projectId={projectId} canWrite={canWrite} />
      ))}
    </div>
  );
}

export function Board({
  projectId,
  tasks,
  groupBy,
  canWrite,
  members,
  milestones,
}: {
  projectId: string;
  tasks: BoardTask[];
  groupBy: GroupBy;
  canWrite: boolean;
  members: Option[];
  milestones: Option[];
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [optimisticTasks, moveOptimistic] = useOptimistic(
    tasks,
    (current, move: { taskId: string; patch: ColumnPatch }) =>
      current.map((t) => (t.id === move.taskId ? { ...t, ...move.patch } : t)),
  );
  const [activeTask, setActiveTask] = useState<BoardTask | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const columns = deriveColumns(groupBy, { members, milestones });

  function handleDragStart(event: DragStartEvent) {
    const task = optimisticTasks.find((t) => t.id === String(event.active.id));
    setActiveTask(task ?? null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const taskId = String(event.active.id);
    const over = event.over?.id;
    if (!over) return;
    const column = columns.find((c) => c.key === String(over));
    const task = optimisticTasks.find((t) => t.id === taskId);
    // 已在目标列则无须提交
    if (!column || !task || column.matches(task)) return;

    startTransition(async () => {
      setError(null);
      moveOptimistic({ taskId, patch: column.patch });
      const res = await moveTaskAction({ taskId, projectId, patch: column.patch });
      if (res?.error) {
        setError(res.error);
        return;
      }
      // 数据回流：新动态进最新记录列表、未读红点立即 +1，不等整页刷新
      window.dispatchEvent(
        new CustomEvent<string>(ACTIVITY_NEW_EVENT, { detail: `project:${projectId}` }),
      );
      router.refresh();
    });
  }

  return (
    <DndContext
      id={`board-${projectId}`}
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {error && <p className="text-sm text-high">{error}</p>}
      {/* 列数随分组维度而变，故横向滚动而非固定三栏 */}
      <div className="flex gap-4 overflow-x-auto pb-2">
        {columns.map((col) => (
          <Column
            key={col.key}
            column={col}
            tasks={optimisticTasks.filter((t) => col.matches(t))}
            projectId={projectId}
            canWrite={canWrite}
          />
        ))}
      </div>
      {/* 拖拽浮层：卡片跟手，原位留低透明幽灵（样式见 project.css 的 proj-ghost） */}
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div className="ac-card proj-card proj-ghost w-72 p-3 text-sm">
            <p className="font-medium text-ink">{activeTask.title}</p>
            <p className="mt-1 text-xs text-ink-soft">
              {activeTask.assigneeName ?? "未分配"}
              {(activeTask.startDate || activeTask.dueDate) &&
                ` · ${activeTask.startDate ?? "…"}→${activeTask.dueDate ?? "…"}`}
            </p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
