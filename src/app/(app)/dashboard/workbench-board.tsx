"use client";

import {
  useEffect,
  useRef,
  useState,
  useOptimistic,
  useTransition,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import type { ColumnPatch } from "@/lib/board-columns";
import { moveTaskAction } from "@/app/(app)/projects/[projectId]/actions";
import { ACTIVITY_NEW_EVENT } from "@/components/activity-feed";
import { dashboardHref } from "@/lib/workbench-filters";

export type WorkbenchTask = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  priority: string;
  startDate: string | null;
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

// 卡片正文（标题 + 项目/优先级/截止 + 子任务进度）。拖拽浮层也复用它，
// 保证浮层宽度与内容同卡片一致，不会比静止时瘦一圈。
function WorkbenchCardBody({
  task,
  today,
  onTitleClick,
}: {
  task: WorkbenchTask;
  today: string;
  onTitleClick?: (e: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  const canWrite = WRITE_ROLES.includes(task.role);
  const overdue = task.dueDate && task.dueDate < today;
  const dueToday = task.dueDate === today;

  return (
    <>
      <Link
        href={`/projects/${task.projectId}/tasks/${task.id}`}
        onClick={onTitleClick}
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
    </>
  );
}

function WorkbenchCard({
  task,
  today,
  locked,
}: {
  task: WorkbenchTask;
  today: string;
  locked: boolean;
}) {
  const canWrite = WRITE_ROLES.includes(task.role);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    disabled: !canWrite || locked,
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
      className={`ac-card proj-card p-3 text-sm transition ${isDragging ? "dragging" : ""}`}
    >
      <div {...listeners} {...attributes}>
        <WorkbenchCardBody
          task={task}
          today={today}
          onTitleClick={(e) => {
            if (suppressClickRef.current) {
              e.preventDefault();
              suppressClickRef.current = false;
            }
          }}
        />
      </div>
    </div>
  );
}

function Column({
  column,
  tasks,
  today,
  locked,
}: {
  column: (typeof COLUMNS)[number];
  tasks: WorkbenchTask[];
  today: string;
  locked: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key, disabled: locked });

  return (
    <div
      ref={setNodeRef}
      className={`proj-column ac-scroll-hidden min-h-40 space-y-2 rounded-xl border border-line p-3 transition-colors ${
        isOver ? "drop" : ""
      }`}
    >
      <h3 className={`flex items-center gap-2 text-sm font-semibold ${column.tone}`}>
        {column.label}
        <span className="ac-badge bg-surface text-ink-soft">{tasks.length}</span>
      </h3>
      {tasks.map((t) => (
        <WorkbenchCard key={t.id} task={t} today={today} locked={locked} />
      ))}
    </div>
  );
}

export function WorkbenchBoard({
  tasks,
  today,
  doneCount,
  hideDone,
  chips,
  projectFilter,
  locked = false,
}: {
  tasks: WorkbenchTask[];
  today: string;
  doneCount: number;
  hideDone: boolean;
  chips: { id: string; name: string }[];
  projectFilter: string | null;
  /** 工作台编辑卡片布局时锁死看板拖拽，避免与外层网格拖拽嵌套 */
  locked?: boolean;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const [activeTask, setActiveTask] = useState<WorkbenchTask | null>(null);
  // 浮层宽度取被拖卡片的实际宽度：看板卡随工作台网格缩放，不能写死 262px
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [optimisticTasks, moveOptimistic] = useOptimistic(
    tasks,
    (current, move: { taskId: string; patch: ColumnPatch }) =>
      current.map((t) => (t.id === move.taskId ? { ...t, ...move.patch } : t)),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    const taskId = String(event.active.id);
    const task = optimisticTasks.find((t) => t.id === taskId);
    setActiveTask(task ?? null);
    // dnd-kit 的 `active.rect.current.initial` 要等它自己的 effect 跑完才写入，
    // onDragStart 这一刻还是 null，取不到宽度。直接量被拖的卡片：用 offsetWidth
    // （布局宽度，不含悬停 3D 旋转），看板随工作台网格缩放时浮层才跟着变。
    const node = document.querySelector<HTMLElement>(
      `[data-task-card-id="${taskId}"]`,
    );
    setDragWidth(node?.offsetWidth || event.active.rect.current.initial?.width || null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    setDragWidth(null);
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
      // 完成后刷新当前 /dashboard 路由，顺带失效项目页缓存
      const res = await moveTaskAction({ taskId, projectId: task.projectId, patch });
      if (res?.error) {
        setError(res.error);
        return;
      }
      // 数据回流：新动态进最新记录列表、未读红点立即 +1，不等整页刷新
      // scope 用字面量，与 lib/activity 的 WORKBENCH_SCOPE 一致
      window.dispatchEvent(new CustomEvent<string>(ACTIVITY_NEW_EVENT, { detail: "workbench" }));
      router.refresh();
    });
  }

  return (
    <DndContext
      id="workbench-board"
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="workbench-board flex h-full min-h-0 flex-col p-4">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-sm font-semibold text-ink">我的任务看板</h2>
          <Link
            href={dashboardHref({ hideDone: !hideDone, project: projectFilter })}
            aria-pressed={hideDone}
            className={`ac-badge ${
              hideDone
                ? "bg-primary text-white"
                : "bg-surface text-ink-soft hover:bg-primary-soft"
            }`}
          >
            隐藏已完成
          </Link>
        </div>

        {chips.length > 0 && (
          <nav className="mt-2 flex shrink-0 flex-wrap items-center gap-1.5" aria-label="按项目筛选">
            <Link
              href={dashboardHref({ hideDone, project: null })}
              aria-pressed={!projectFilter}
              className={`ac-badge ${
                !projectFilter
                  ? "bg-primary text-white"
                  : "bg-surface text-ink-soft hover:bg-primary-soft"
              }`}
            >
              全部
            </Link>
            {chips.map((c) => (
              <Link
                key={c.id}
                href={dashboardHref({ hideDone, project: c.id })}
                aria-pressed={projectFilter === c.id}
                className={`ac-badge ${
                  projectFilter === c.id
                    ? "bg-primary text-white"
                    : "bg-surface text-ink-soft hover:bg-primary-soft"
                }`}
              >
                {c.name}
              </Link>
            ))}
          </nav>
        )}

        {error && <p className="mt-1 text-sm text-high">{error}</p>}

        <div className="workbench-board-content ac-scroll-hidden mt-2 min-h-0 flex-1">
          <div className="workbench-columns grid gap-4">
            {COLUMNS.map((col) => (
              <Column
                key={col.key}
                column={col}
                tasks={optimisticTasks.filter((t) => t.status === col.key)}
                today={today}
                locked={locked}
              />
            ))}
          </div>
        </div>

        {/* 过滤态下 done 列仍可落卡（服务端过滤会在回流后吞掉它），底部提示被隐藏的数量 */}
        {hideDone && (
          <p className="mt-2 shrink-0 text-xs text-ink-faint">
            已隐藏 {doneCount} 个已完成任务
          </p>
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeTask ? (
          <div
            className="ac-card proj-card proj-ghost w-[262px] p-3 text-sm"
            style={dragWidth ? { width: dragWidth } : undefined}
          >
            <WorkbenchCardBody task={activeTask} today={today} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
