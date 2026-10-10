"use client";

import { useEffect, useRef, useState, useOptimistic, useTransition } from "react";
import Link from "next/link";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { ColumnPatch } from "@/lib/board-columns";
import { moveTaskAction } from "@/app/(app)/projects/[projectId]/actions";

export type WorkbenchTask = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  priority: string;
  dueDate: string | null;
  projectId: string;
  projectName: string;
  role: "admin" | "teacher" | "student";
  subTotal?: number;
  subDone?: number;
};

// 与 TASK_WRITE_ROLES（lib/task.ts）同集：admin/student 可写，teacher 只读。
// 常量未导出，本地复制以免动共享文件（先例：任务详情页 PRIORITY_BADGE）。
const WRITE_ROLES = ["admin", "student"];

const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-high-soft text-high",
  medium: "bg-medium-soft text-medium",
  low: "bg-low-soft text-low",
};

// 三列固定（照 board-columns.ts 的 status 分支；不共用 deriveColumns，其签名绑 members/milestones）
const COLUMNS = [
  { key: "todo", label: "待办", tone: "text-todo" },
  { key: "doing", label: "进行中", tone: "text-doing" },
  { key: "done", label: "已完成", tone: "text-done" },
] as const;

function WorkbenchCard({ task, today }: { task: WorkbenchTask; today: string }) {
  const canWrite = WRITE_ROLES.includes(task.role);
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

  const overdue = task.dueDate && task.dueDate < today;
  const dueToday = task.dueDate === today;

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
      <div {...listeners} {...attributes} className={canWrite ? "cursor-grab" : ""}>
        <Link
          href={`/projects/${task.projectId}/tasks/${task.id}`}
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
        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="ac-badge bg-primary-soft text-primary">{task.projectName}</span>
          {!canWrite && <span className="ac-badge bg-sunken text-ink-faint">只读</span>}
          <span className={`ac-badge ${PRIORITY_BADGE[task.priority] ?? "bg-low-soft text-low"}`}>
            {task.priority}
          </span>
          {task.dueDate &&
            (overdue ? (
              <span className="ac-badge bg-high-soft text-high">{task.dueDate} 逾期</span>
            ) : dueToday ? (
              <span className="ac-badge bg-medium-soft text-medium">今天截止</span>
            ) : (
              <span className="text-ink-faint">截止 {task.dueDate}</span>
            ))}
        </p>
        {task.subTotal != null && task.subTotal > 0 && (
          <div className="mt-2">
            <p className="text-xs text-ink-faint">
              子任务 <span className="tabular-nums">{task.subDone ?? 0}/{task.subTotal}</span>
            </p>
            {/* 动态宽度须内联 style（Tailwind 不生成拼接类名），先例 projects/page.tsx */}
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
              <div
                className="h-full rounded-full bg-done"
                style={{
                  width: `${Math.round(((task.subDone ?? 0) / task.subTotal) * 100)}%`,
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Column({
  column,
  tasks,
  today,
}: {
  column: (typeof COLUMNS)[number];
  tasks: WorkbenchTask[];
  today: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key });

  return (
    <div
      ref={setNodeRef}
      className={`min-h-40 space-y-2 rounded-xl border border-line p-3 transition-colors ${
        isOver ? "bg-primary-soft" : "bg-sunken"
      }`}
    >
      <h3 className={`flex items-center gap-2 text-sm font-semibold ${column.tone}`}>
        {column.label}
        <span className="ac-badge bg-surface text-ink-soft">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <WorkbenchCard key={t.id} task={t} today={today} />
      ))}
    </div>
  );
}

export function WorkbenchBoard({
  tasks,
  today,
  doneCount,
  hideDone,
}: {
  tasks: WorkbenchTask[];
  today: string;
  doneCount: number;
  hideDone: boolean;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [optimisticTasks, moveOptimistic] = useOptimistic(
    tasks,
    (current, move: { taskId: string; patch: ColumnPatch }) =>
      current.map((t) => (t.id === move.taskId ? { ...t, ...move.patch } : t)),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const taskId = String(event.active.id);
    const over = event.over?.id;
    if (!over) return;
    const key = String(over) as (typeof COLUMNS)[number]["key"];
    if (!COLUMNS.some((c) => c.key === key)) return;
    const task = optimisticTasks.find((t) => t.id === taskId);
    // 已在目标列则无须提交
    if (!task || task.status === key) return;

    const patch: ColumnPatch = { status: key };
    startTransition(async () => {
      setError(null);
      moveOptimistic({ taskId, patch });
      // 复用项目看板的 action：权限校验在 updateTask 内逐任务判角色（teacher 拒），
      // 完成后 REFRESH 刷新当前 /dashboard 路由，顺带失效项目页缓存
      const res = await moveTaskAction({ taskId, projectId: task.projectId, patch });
      if (res?.error) setError(res.error);
    });
  }

  return (
    <DndContext id="workbench-board" sensors={sensors} onDragEnd={handleDragEnd}>
      {error && <p className="text-sm text-high">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        {COLUMNS.map((col) => (
          <Column
            key={col.key}
            column={col}
            tasks={optimisticTasks.filter((t) => t.status === col.key)}
            today={today}
          />
        ))}
      </div>
      {/* 过滤态下 done 列仍可落卡（服务端过滤会在回流后吞掉它），底部提示被隐藏的数量 */}
      {hideDone && (
        <p className="mt-2 text-xs text-ink-faint">已隐藏 {doneCount} 个已完成任务</p>
      )}
    </DndContext>
  );
}
