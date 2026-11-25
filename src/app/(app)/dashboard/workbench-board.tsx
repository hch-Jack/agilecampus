"use client";

import {
  useEffect,
  useRef,
  useState,
  useOptimistic,
  useTransition,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { PRIORITY_BADGE } from "@/lib/task-constants";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
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
import { SubtaskProgress } from "@/components/subtask-progress";
import { dashboardHref } from "@/lib/workbench-filters";
import { CompletionRequestModal } from "@/components/completion-request-modal";
import { WorkbenchApprovalModal } from "./approval-status-modal";
import { ApprovalHistoryModal } from "./approval-history-modal";
import { isOverdueTask, sortBoardTasks } from "@/lib/workbench-order";
import {
  workbenchColumnForTask,
  type WorkbenchColumnKey,
} from "@/lib/workbench-board-columns";

export /** 看板列命中：用指针位置兜底，避免 dnd-kit 的 over 在某些布局/缩放下为空 */
function columnKeyAt(x: number, y: number): string | null {
  // 拖拽浮层可能盖在指针下面，用 elementsFromPoint 找到第一个真正属于列的节点
  for (const el of document.elementsFromPoint(x, y)) {
    const col = el.closest<HTMLElement>("[data-board-column]");
    if (col) return col.dataset.boardColumn ?? null;
  }
  return null;
}

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
  /** 完成是否需要审批（建任务时可选）：false 时学生拖到「已完成」即直接完成 */
  requireApproval: boolean;
  subTotal?: number;
  subDone?: number;
  /**
   * 我（作为申请人）在这个任务上最近一次完成审批的状态；从未申请过则缺省。
   * 学生据此看到 审批中/已通过/已驳回 的醒目徽章（点开看详情）。
   */
  approvalStatus?: "pending" | "approved" | "rejected";
  approvalApproverName?: string | null;
  approvalDecidedAt?: Date | null;
  approvalRequestedAt?: Date | null;
};

// 与 TASK_WRITE_ROLES（lib/task.ts）同集：admin/student 可写，teacher 只读。
const WRITE_ROLES = ["admin", "student"];

// 四列固定（照 board-columns.ts 的 status 分支；不共用 deriveColumns，其签名绑 members/milestones）。
// 「待审批」由 pending 的完成申请派生，不新增任务状态；带申请的任务只出现在这一列。
const COLUMNS: ReadonlyArray<{
  key: WorkbenchColumnKey;
  label: string;
  tone: string;
  /** 落列提交的状态补丁：待审批列等同「已完成」，由审批流转成完成申请 */
  patch: ColumnPatch;
}> = [
  { key: "todo", label: "待办", tone: "text-todo", patch: { status: "todo" } },
  { key: "doing", label: "进行中", tone: "text-doing", patch: { status: "doing" } },
  { key: "pending", label: "待审批", tone: "text-medium", patch: { status: "done" } },
  { key: "done", label: "已完成", tone: "text-done", patch: { status: "done" } },
];

// 完成审批状态的醒目徽章：学生提交完成申请后出现在自己的任务卡上，
// 点开可看审批详情（审批中/已通过/已驳回）。stopPropagation 防误触拖拽。
function ApprovalBadge({
  task,
  onOpen,
}: {
  task: WorkbenchTask;
  onOpen: () => void;
}) {
  if (!task.approvalStatus) return null;
  const view = {
    pending: { text: "⏳ 审批中", cls: "border border-medium bg-medium-soft font-medium text-medium" },
    approved: { text: "✓ 已通过", cls: "border border-done bg-done/10 font-medium text-done" },
    rejected: { text: "✗ 已驳回", cls: "border border-high bg-high-soft font-medium text-high" },
  }[task.approvalStatus];
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      className={`ac-badge ${view.cls} transition-transform hover:scale-105`}
      title="查看完成审批情况"
    >
      {view.text}
    </button>
  );
}

// 卡片正文（标题 + 项目/优先级/截止 + 子任务进度）。拖拽浮层也复用它，
// 保证浮层宽度与内容同卡片一致，不会比静止时瘦一圈。
function WorkbenchCardBody({
  task,
  today,
  onTitleClick,
  onOpenApproval,
}: {
  task: WorkbenchTask;
  today: string;
  onTitleClick?: (e: ReactMouseEvent<HTMLAnchorElement>) => void;
  onOpenApproval?: () => void;
}) {
  const canWrite = WRITE_ROLES.includes(task.role);
  const overdue = isOverdueTask(task, today);
  const dueToday = !overdue && task.dueDate === today;

  return (
    <>
      <Link
        href={`/projects/${task.projectId}/tasks/${task.id}`}
        onClick={onTitleClick}
        className={`dw-body font-medium text-ink hover:text-primary ${
          canWrite ? "cursor-grab" : "cursor-pointer"
        }`}
      >
        {task.title}
      </Link>
      <p className="dw-meta mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="ac-badge bg-primary-soft text-primary">{task.projectName}</span>
        {onOpenApproval && <ApprovalBadge task={task} onOpen={onOpenApproval} />}
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
      <SubtaskProgress total={task.subTotal ?? 0} done={task.subDone ?? 0} />
    </>
  );
}

function WorkbenchCard({
  task,
  today,
  locked,
  onOpenApproval,
}: {
  task: WorkbenchTask;
  today: string;
  locked: boolean;
  onOpenApproval?: () => void;
}) {
  const router = useRouter();
  const canWrite = WRITE_ROLES.includes(task.role);
  const overdue = isOverdueTask(task, today);
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
      {...listeners}
      {...attributes}
      onClick={(e) => {
        if (suppressClickRef.current) {
          e.preventDefault();
          suppressClickRef.current = false;
          return;
        }
        // 标题链、审批徽章、按钮自己处理点击；其余空白处也进任务详情
        if ((e.target as Element | null)?.closest?.("a,button,input,select,textarea")) return;
        router.push(`/projects/${task.projectId}/tasks/${task.id}`);
      }}
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
      className={`ac-card workbench-card proj-card relative p-3 text-sm transition ${
        overdue ? "is-overdue" : ""
      } ${isDragging ? "dragging" : ""}`}
    >
      <WorkbenchCardBody
        task={task}
        today={today}
        onTitleClick={(e) => {
          if (suppressClickRef.current) {
            e.preventDefault();
            suppressClickRef.current = false;
          }
        }}
        onOpenApproval={onOpenApproval}
      />
    </div>
  );
}

function Column({
  column,
  tasks,
  today,
  locked,
  highlight,
  onOpenApproval,
}: {
  column: (typeof COLUMNS)[number];
  tasks: WorkbenchTask[];
  today: string;
  locked: boolean;
  highlight: boolean;
  onOpenApproval: (task: WorkbenchTask) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: column.key, disabled: locked });
  // 逾期卡片置顶、逾期最久的在前；非逾期保持服务端顺序
  const ordered = sortBoardTasks(tasks, today);

  return (
    <div
      ref={setNodeRef}
      data-board-column={column.key}
      // 手机上多列会竖排，空列 min-h-40 会把整块撑得很长，缩到 6rem
      className={`proj-column ac-scroll-hidden min-h-40 space-y-2 rounded-xl border border-line p-3 transition-colors max-sm:min-h-24 ${
        isOver || highlight ? "drop" : ""
      }`}
    >
      <h3 className={`dw-item flex items-center gap-2 font-semibold ${column.tone}`}>
        {column.label}
        <span className="ac-badge bg-surface text-ink-soft">{tasks.length}</span>
      </h3>
      {ordered.map((t) => (
        <WorkbenchCard
          key={t.id}
          task={t}
          today={today}
          locked={locked}
          onOpenApproval={t.approvalStatus ? () => onOpenApproval(t) : undefined}
        />
      ))}
    </div>
  );
}

export function WorkbenchBoard({
  tasks,
  today,
  timeZone,
  doneCount,
  hideDone,
  chips,
  projectFilter,
  locked = false,
}: {
  tasks: WorkbenchTask[];
  today: string;
  /** 用户时区（审批详情里的时刻按它显示；服务端算好传入） */
  timeZone: string;
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
  // 「隐藏已完成」时连整列一起收掉：服务端已经把 done 任务过滤掉，
  // 再留一个空列只会白占四分之一宽度
  const columns = hideDone ? COLUMNS.filter((c) => c.key !== "done") : COLUMNS;
  const [activeTask, setActiveTask] = useState<WorkbenchTask | null>(null);
  // 学生拖到「已完成」→ 完成申请弹窗（确认 + 填写完成情况/附件）；审批详情弹窗
  const [completionTask, setCompletionTask] = useState<WorkbenchTask | null>(null);
  const [approvalTask, setApprovalTask] = useState<WorkbenchTask | null>(null);
  // 看板右上角「审批记录」：我发起的 + 我审批过的全部记录
  const [historyOpen, setHistoryOpen] = useState(false);
  // 浮层宽度取被拖卡片的实际宽度：看板卡随工作台网格缩放，不能写死 262px
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const dragPointRef = useRef<{ x: number; y: number } | null>(null);

  // dnd-kit 的 over 在缩放/嵌套容器里可能一直是 undefined：自己按指针位置找列，
  // 同时用它驱动列高亮，结束拖拽时也用它兜底落列。
  useEffect(() => {
    if (!activeTask) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      dragPointRef.current = { x: e.clientX, y: e.clientY };
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const p = dragPointRef.current;
        setOverKey(p ? columnKeyAt(p.x, p.y) : null);
      });
    };
    window.addEventListener("pointermove", onMove, true);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove, true);
      setOverKey(null);
    };
  }, [activeTask]);
  const [optimisticTasks, moveOptimistic] = useOptimistic(
    tasks,
    (
      current,
      move: { taskId: string; patch: ColumnPatch; clearApproval?: boolean },
    ) =>
      current.map((t) =>
        t.id === move.taskId
          ? {
              ...t,
              ...move.patch,
              // 待审批卡拖回待办/进行中 = 撤回申请：同步摘掉申请状态，卡片立即回列
              ...(move.clearApproval ? { approvalStatus: undefined } : {}),
            }
          : t,
      ),
  );
  // 与项目看板同一口径：鼠标按下移 4px 即拖；触屏长按 250ms 才拖，否则交给页面滚动
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 6 } }),
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
    const point = dragPointRef.current;
    dragPointRef.current = null;
    const over = event.over?.id ?? (point ? columnKeyAt(point.x, point.y) : null);
    if (!over) return;
    const key = String(over) as WorkbenchColumnKey;
    const column = columns.find((c) => c.key === key);
    const task = optimisticTasks.find((t) => t.id === taskId);
    // 已在目标列则无须提交（待审批列的卡底层状态可能已是 doing，不能只比 status）
    if (!column || !task || workbenchColumnForTask(task) === key) return;

    const isPending = task.approvalStatus === "pending";

    // 审批中的卡片只允许拖回待办/进行中（= 撤回申请）；拖到待审批/已完成不作为
    if (isPending && column.patch.status === "done") return;

    // 学生把任务拖到「待审批」或「已完成」：需要审批的才弹完成申请窗（确认 + 完成情况/附件）。
    // 任务停留在原列，提交受理后由整页回流带出「审批中」徽章。
    // 建任务时关掉了「需要审批」的任务不弹窗，走下面的普通改状态分支直接完成。
    if (
      column.patch.status === "done" &&
      task.role === "student" &&
      task.status !== "done" &&
      task.requireApproval
    ) {
      setCompletionTask(task);
      return;
    }
    // 待审批卡拖回待办/进行中：服务端 updateTask 会撤掉未决申请，客户端同步清字段
    const clearApproval = isPending;

    startTransition(async () => {
      setError(null);
      moveOptimistic({ taskId, patch: column.patch, clearApproval });
      // 复用项目看板的 action：权限校验在 updateTask 内逐任务判角色（teacher 拒），
      // 完成后刷新当前 /dashboard 路由，顺带失效项目页缓存
      const res = await moveTaskAction({
        taskId,
        projectId: task.projectId,
        patch: column.patch,
      });
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
          <h2 className="dw-title font-display font-semibold text-ink">我的任务看板</h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              className="ac-btn-ghost px-2.5 py-1 text-xs"
            >
              审批记录
            </button>
            <Link
              href={dashboardHref({ hideDone: !hideDone, project: projectFilter })}
              // 筛选只是换数据，不该把已经翻到下面的用户弹回页首
              scroll={false}
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
        </div>

        {chips.length > 0 && (
          <nav className="mt-2 flex shrink-0 flex-wrap items-center gap-1.5" aria-label="按项目筛选">
            <Link
              href={dashboardHref({ hideDone, project: null })}
              scroll={false}
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
                scroll={false}
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

        {error && <p className="dw-body mt-1 text-high">{error}</p>}

        <div className="workbench-board-content ac-scroll-hidden mt-2 min-h-0 flex-1">
          <div
            className="workbench-columns grid gap-4"
            style={{ "--workbench-cols": columns.length } as CSSProperties}
          >
            {columns.map((col) => (
              <Column
                key={col.key}
                column={col}
                tasks={optimisticTasks.filter((t) => workbenchColumnForTask(t) === col.key)}
                today={today}
                locked={locked}
                highlight={overKey === col.key}
                onOpenApproval={setApprovalTask}
              />
            ))}
          </div>
        </div>

        {/* 过滤态下 done 列仍可落卡（服务端过滤会在回流后吞掉它），底部提示被隐藏的数量 */}
        {hideDone && (
          <p className="dw-meta mt-2 shrink-0 text-ink-faint">
            已隐藏 {doneCount} 个已完成任务
          </p>
        )}
      </div>
      {completionTask && (
        <CompletionRequestModal
          taskId={completionTask.id}
          projectId={completionTask.projectId}
          taskTitle={completionTask.title}
          onClose={() => setCompletionTask(null)}
        />
      )}
      {approvalTask?.approvalStatus && (
        <WorkbenchApprovalModal
          taskTitle={approvalTask.title}
          status={approvalTask.approvalStatus}
          approverName={approvalTask.approvalApproverName}
          decidedAt={approvalTask.approvalDecidedAt}
          requestedAt={approvalTask.approvalRequestedAt}
          timeZone={timeZone}
          onClose={() => setApprovalTask(null)}
        />
      )}
      {historyOpen && (
        <ApprovalHistoryModal timeZone={timeZone} onClose={() => setHistoryOpen(false)} />
      )}
      {/* 工作台网格会对卡片做缩放/3D 变换：浮层留在原地会被祖先的 transform
          一起缩放，看起来不跟手。portal 到 body 后与项目看板一样跟随鼠标。 */}
      {activeTask &&
        typeof document !== "undefined" &&
        createPortal(
          <DragOverlay dropAnimation={null}>
            <div
              className={`ac-card workbench-card proj-card proj-ghost w-[262px] p-3 text-sm ${
                isOverdueTask(activeTask, today) ? "is-overdue" : ""
              }`}
              style={dragWidth ? { width: dragWidth } : undefined}
            >
              <WorkbenchCardBody task={activeTask} today={today} />
            </div>
          </DragOverlay>,
          document.body,
        )}
    </DndContext>
  );
}
