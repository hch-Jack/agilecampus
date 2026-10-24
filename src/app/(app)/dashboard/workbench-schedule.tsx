import Link from "next/link";
import {
  buildTimeScale,
  formatMonthDay as fmtMD,
  inferTaskSpan,
  parseDay,
} from "@/lib/gantt";
import type { TaskPlanSegment } from "@/lib/task-plan";
import type { WorkbenchTask } from "./workbench-board";
import { WorkbenchCalendar } from "./workbench-calendar";

// 日程表：任务官方起止的时间线（甘特，只读）+ 月历（标记起止、编辑个人计划日）。
// 两者同属「日程表」一个模块：甘特看整体跨度与今日竖线，月历把任务摆到具体某天
// 并自记「我打算哪天做」。任务官方起止日不动（只读），可编辑的只有个人计划日。
// 按项目分组（首次出现顺序），与看板的项目筛选态同源（见 dashboard/page.tsx 的 visible）。

const STATUS_BAR: Record<string, string> = {
  todo: "bg-todo",
  doing: "bg-doing",
  done: "bg-done",
};

type Bar = {
  task: WorkbenchTask;
  leftPct: number;
  widthPct: number;
  overdue: boolean;
};

export function WorkbenchSchedule({
  tasks,
  plans,
  today,
}: {
  tasks: WorkbenchTask[];
  plans: Record<string, TaskPlanSegment[]>;
  today: string;
}) {
  if (tasks.length === 0) return null;

  const todayMs = parseDay(today)!;
  const scheduled: { task: WorkbenchTask; start: number; end: number }[] = [];
  const unscheduled: WorkbenchTask[] = [];
  for (const t of tasks) {
    const span = inferTaskSpan(t.startDate, t.dueDate);
    if (!span) {
      unscheduled.push(t);
      continue;
    }
    scheduled.push({ task: t, ...span });
  }

  // 时间范围：涵盖全部横条 + 今日，两端各留 4% 余白（关系图/时间线页共用同一套算法）
  const scale = buildTimeScale({
    spans: scheduled.map((s) => ({ start: s.start, end: s.end })),
    milestoneTargetDates: [],
    projectStartDate: null,
    projectEndDate: null,
    todayMs,
  });
  const pct = scale.pct;
  const todayPct = pct(todayMs);

  // 按项目分组（保持首次出现顺序）
  const groups: { projectId: string; projectName: string; bars: Bar[] }[] = [];
  const ensure = (task: WorkbenchTask) => {
    let g = groups.find((x) => x.projectId === task.projectId);
    if (!g) {
      g = { projectId: task.projectId, projectName: task.projectName, bars: [] };
      groups.push(g);
    }
    return g;
  };
  for (const { task, start, end } of scheduled) {
    const overdue =
      task.status !== "done" &&
      task.dueDate !== null &&
      (parseDay(task.dueDate) ?? 0) < todayMs;
    ensure(task).bars.push({
      task,
      leftPct: pct(start),
      widthPct: Math.max(pct(end) - pct(start), 1.5),
      overdue,
    });
  }

  return (
    <section aria-label="任务日程" className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-base font-semibold text-ink">日程表</h2>
        <p className="text-xs text-ink-faint">横条为官方起止，竖线为今日</p>
      </div>

      {scheduled.length > 0 ? (
        <div className="ac-card overflow-hidden">
          {/* 时间刻度头 */}
          <div className="relative border-b border-line bg-sunken/60 px-4 py-2">
            <div className="relative ml-40 h-4">
              {scale.ticks.map((t, i) => (
                <span
                  key={i}
                  className="absolute -translate-x-1/2 text-[11px] tabular-nums text-ink-faint"
                  style={{ left: `${pct(t)}%` }}
                >
                  {fmtMD(t)}
                </span>
              ))}
            </div>
          </div>

          {groups.map((g) => (
            <div key={g.projectId} className="border-b border-line last:border-b-0">
              <div className="bg-sunken/40 px-4 py-1.5 text-xs font-semibold text-ink-soft">
                {g.projectName}
              </div>
              <ul>
                {g.bars.map((b) => {
                  const rangeLabel = `${b.task.startDate ?? "…"}→${b.task.dueDate ?? "…"}`;
                  return (
                    <li key={b.task.id} className="flex items-center px-4 py-1.5">
                      <Link
                        href={`/projects/${b.task.projectId}/tasks/${b.task.id}`}
                        className="w-40 shrink-0 truncate pr-2 text-xs text-ink hover:text-primary"
                        title={b.task.title}
                      >
                        {b.task.title}
                      </Link>
                      <span className="relative h-5 flex-1">
                        {todayPct >= 0 && todayPct <= 100 && (
                          <span
                            className="pointer-events-none absolute inset-y-0 w-px bg-accent/70"
                            style={{ left: `${todayPct}%` }}
                            aria-hidden
                          />
                        )}
                        <span
                          className={`absolute top-0 flex h-5 items-center overflow-hidden rounded px-1.5 text-[10px] text-white ${
                            b.overdue ? "bg-high" : STATUS_BAR[b.task.status] ?? "bg-todo"
                          }`}
                          style={{
                            left: `${b.leftPct}%`,
                            width: `${b.widthPct}%`,
                            minWidth: "2rem",
                          }}
                          title={rangeLabel}
                        >
                          <span className="truncate">{rangeLabel}</span>
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

          {/* 图例 */}
          <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-soft">
            <Legend cls="bg-todo" label="待办" />
            <Legend cls="bg-doing" label="进行中" />
            <Legend cls="bg-done" label="已完成" />
            <Legend cls="bg-high" label="逾期" />
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-px bg-accent/70" /> 今日
            </span>
          </div>
        </div>
      ) : (
        <p className="px-1 text-xs text-ink-faint">
          尚无任务设了官方起止日——在项目里给任务排期后，时间线会出现在上方
        </p>
      )}

      {/* 月历：标记任务官方起止（只读），并把任务安排到「我打算哪天做」的计划日 */}
      <WorkbenchCalendar tasks={tasks} plans={plans} today={today} />

      {unscheduled.length > 0 && <UnscheduledList tasks={unscheduled} />}
    </section>
  );
}

function UnscheduledList({ tasks }: { tasks: WorkbenchTask[] }) {
  return (
    <div className="ac-card p-4">
      <h3 className="mb-2 text-xs font-semibold text-ink">未设官方起止（{tasks.length}）</h3>
      <ul className="flex flex-wrap gap-2">
        {tasks.map((t) => (
          <li key={t.id}>
            <Link
              href={`/projects/${t.projectId}/tasks/${t.id}`}
              className="ac-badge bg-sunken text-ink-soft hover:text-primary"
            >
              {t.title}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}
