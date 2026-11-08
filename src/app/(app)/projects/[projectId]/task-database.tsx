import Link from "next/link";
import type { SubtaskProgress } from "@/lib/board-tasks";

// 状态/优先级徽章配色与看板任务卡一致；此处为服务端组件，不从 client 模块引常量
const STATUS_BADGE: Record<"todo" | "doing" | "done", { cls: string; label: string }> = {
  todo: { cls: "bg-sunken text-ink-soft", label: "待办" },
  doing: { cls: "bg-doing/10 text-doing", label: "进行中" },
  done: { cls: "bg-done/10 text-done", label: "已完成" },
};

const PRIORITY_BADGE: Record<string, { cls: string; label: string }> = {
  high: { cls: "bg-high-soft text-high", label: "高" },
  medium: { cls: "bg-medium-soft text-medium", label: "中" },
  low: { cls: "bg-low-soft text-low", label: "低" },
};

const LABEL_CHIP: Record<string, string> = {
  slate: "bg-sunken text-ink-soft",
  red: "bg-high-soft text-high",
  amber: "bg-medium-soft text-medium",
  green: "bg-low-soft text-low",
  blue: "bg-primary-soft text-primary",
  violet: "bg-primary-soft text-primary",
  pink: "bg-high-soft text-high",
};

export type TaskDatabaseRow = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  parentTaskId: string | null;
  assigneeName: string | null;
  milestoneId: string | null;
  labels: { id: string; name: string; color: string }[];
};

/**
 * 任务数据库：Notion 数据库式的任务一览（卡片内嵌表格）。
 * 只读展示全项目任务及其属性，点任务名进详情；看板负责拖拽操作，这里负责总览。
 */
export function TaskDatabase({
  projectId,
  tasks,
  milestones,
  progress,
}: {
  projectId: string;
  /** listProjectTasks 的全量任务（含子任务） */
  tasks: TaskDatabaseRow[];
  milestones: { id: string; title: string }[];
  /** 顶层任务的子任务完成度（splitBoardTasks 聚合，与看板同源） */
  progress: Map<string, SubtaskProgress>;
}) {
  const milestoneName = new Map(milestones.map((m) => [m.id, m.title]));
  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <section className="ac-card overflow-hidden p-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <h2 className="font-medium text-ink">任务数据库</h2>
        <span className="ac-badge bg-surface text-ink-soft">{tasks.length}</span>
        <span className="ml-auto text-xs text-ink-faint">
          已完成 {done} · 点任务名进详情
        </span>
      </div>

      {tasks.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-faint">
          项目还没有任务，创建后这里会以数据库形式列出所有任务。
        </p>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <div className="min-w-[720px]">
            {/* 表头 */}
            <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_76px_64px_92px_120px_140px] items-center gap-2 border-b border-line bg-surface/95 px-5 py-2 text-xs font-medium text-ink-faint backdrop-blur">
              <span>任务</span>
              <span>状态</span>
              <span>优先级</span>
              <span>负责人</span>
              <span>里程碑</span>
              <span>日期</span>
            </div>
            {tasks.map((task) => {
              const sub = task.parentTaskId ? null : progress.get(task.id);
              return (
                <div
                  key={task.id}
                  className="grid grid-cols-[minmax(0,1fr)_76px_64px_92px_120px_140px] items-center gap-2 border-b border-line px-5 py-2 text-sm transition-colors last:border-b-0 hover:bg-sunken"
                >
                  <div className="min-w-0">
                    <div
                      className="flex min-w-0 items-center gap-1.5"
                      style={task.parentTaskId ? { paddingLeft: 18 } : undefined}
                    >
                      {task.parentTaskId && (
                        <span aria-hidden className="shrink-0 text-xs text-ink-faint">
                          └
                        </span>
                      )}
                      <Link
                        href={`/projects/${projectId}/tasks/${task.id}`}
                        className="truncate text-ink hover:text-primary"
                        title={task.title}
                      >
                        {task.title}
                      </Link>
                      {sub && (
                        <span className="shrink-0 text-xs text-ink-faint">
                          子任务 {sub.done}/{sub.total}
                        </span>
                      )}
                    </div>
                    {task.labels.length > 0 && (
                      <div
                        className="mt-0.5 flex flex-wrap gap-1"
                        style={task.parentTaskId ? { paddingLeft: 24 } : undefined}
                      >
                        {task.labels.slice(0, 3).map((l) => (
                          <span
                            key={l.id}
                            className={`ac-badge px-1.5 py-0 text-[11px] ${
                              LABEL_CHIP[l.color] ?? "bg-sunken text-ink-soft"
                            }`}
                          >
                            {l.name}
                          </span>
                        ))}
                        {task.labels.length > 3 && (
                          <span className="text-[11px] text-ink-faint">
                            +{task.labels.length - 3}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <span>
                    <span className={`ac-badge ${STATUS_BADGE[task.status].cls}`}>
                      {STATUS_BADGE[task.status].label}
                    </span>
                  </span>
                  <span>
                    <span className={`ac-badge ${PRIORITY_BADGE[task.priority]?.cls ?? "bg-low-soft text-low"}`}>
                      {PRIORITY_BADGE[task.priority]?.label ?? "低"}
                    </span>
                  </span>
                  <span className="truncate text-xs text-ink-soft">
                    {task.assigneeName ?? "—"}
                  </span>
                  <span className="truncate text-xs text-ink-soft">
                    {task.milestoneId ? (milestoneName.get(task.milestoneId) ?? "—") : "—"}
                  </span>
                  <span className="text-xs text-ink-faint">
                    {task.startDate || task.dueDate
                      ? `${task.startDate ?? "?"} ~ ${task.dueDate ?? "?"}`
                      : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
