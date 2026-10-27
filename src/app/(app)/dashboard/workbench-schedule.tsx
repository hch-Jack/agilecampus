"use client";

import Link from "next/link";
import { useState } from "react";
import type { ReactNode } from "react";
import {
  buildTimeScale,
  formatMonthDay as fmtMD,
  inferTaskSpan,
  parseDay,
} from "@/lib/gantt";
import {
  SCHEDULE_GANTT_RATIO_MAX,
  SCHEDULE_GANTT_RATIO_MIN,
  SCHEDULE_POOL_RATIO_MAX,
  SCHEDULE_POOL_RATIO_MIN,
  type DashboardWidgetConfig,
} from "@/lib/dashboard-layout";
import type { TaskPlanSegment } from "@/lib/task-plan";
import type { WorkbenchTask } from "./workbench-board";
import { WorkbenchCalendar } from "./workbench-calendar";
import { TrackSplitter } from "./track-splitter";

// 日程表：任务官方起止的时间线（甘特，只读）+ 月历（标记起止、编辑个人计划日）。
// 两者同属「日程表」一个模块：甘特看整体跨度与今日竖线，月历把任务摆到具体某天
// 并自记「我打算哪天做」。任务官方起止日不动（只读），可编辑的只有个人计划日。
// 按项目分组（首次出现顺序），与看板的项目筛选态同源（见 dashboard/page.tsx 的 visible）。
//
// 三段（甘特 / 任务池 / 月历）都可以关掉；甘特与月历之间、任务池与月历之间各有一条
// 拖拽条改占比，比例与开关一起存进卡片 config（users.dashboard_layout 的 JSONB）。

const STATUS_BAR: Record<string, string> = {
  todo: "bg-todo",
  doing: "bg-doing",
  done: "bg-done",
};

/** 甘特默认占内容区的 38%：默认 9 行高时大约能露 4 条任务，其余交给月历 */
const DEFAULT_GANTT_RATIO = 0.38;
/** 宽卡时任务池默认占正文的 30%（约 220px） */
const DEFAULT_POOL_RATIO = 0.3;

const roundRatio = (ratio: number) => Math.round(ratio * 1000) / 1000;

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
  config,
  onConfigChange,
}: {
  tasks: WorkbenchTask[];
  plans: Record<string, TaskPlanSegment[]>;
  today: string;
  config?: DashboardWidgetConfig;
  onConfigChange?: (patch: DashboardWidgetConfig, immediate?: boolean) => void;
}) {
  // 拖拽中的比例只放本地：即时重排，松手才写回 config
  // （避免每个 pointermove 都触发一次布局测量与保存）。null = 跟随已保存的配置。
  const [ganttPreview, setGanttPreview] = useState<number | null>(null);
  const [poolPreview, setPoolPreview] = useState<number | null>(null);
  const ganttRatio = ganttPreview ?? config?.ganttRatio ?? DEFAULT_GANTT_RATIO;
  const poolRatio = poolPreview ?? config?.poolRatio ?? DEFAULT_POOL_RATIO;

  const showGantt = config?.showGantt !== false;
  const showPool = config?.showPool !== false;
  const showCalendar = config?.showCalendar !== false;

  function toggleModule(key: "showGantt" | "showPool" | "showCalendar") {
    const current = config?.[key] !== false;
    onConfigChange?.({ [key]: !current }, true);
  }

  function commitGanttRatio(ratio: number) {
    const next = roundRatio(ratio);
    if (!onConfigChange) {
      setGanttPreview(next);
      return;
    }
    setGanttPreview(null);
    onConfigChange({ ganttRatio: next }, true);
  }

  function commitPoolRatio(ratio: number) {
    const next = roundRatio(ratio);
    if (!onConfigChange) {
      setPoolPreview(next);
      return;
    }
    setPoolPreview(null);
    onConfigChange({ poolRatio: next }, true);
  }

  if (tasks.length === 0)
    return <p className="dw-schedule-empty px-1 text-xs text-ink-faint">暂无分配给你的任务。</p>;

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
    <section aria-label="任务日程" className="dw-schedule">
      <h2 className="font-display text-sm font-semibold text-ink">日程表</h2>
      {/* 模块开关：随时关掉不看的部分，比例与开关都按卡片保存 */}
      <div className="dw-schedule-tools" role="group" aria-label="日程表显示模块">
        <ModuleToggle pressed={showGantt} onClick={() => toggleModule("showGantt")}>
          甘特
        </ModuleToggle>
        <ModuleToggle
          pressed={showCalendar && showPool}
          disabled={!showCalendar}
          onClick={() => toggleModule("showPool")}
        >
          任务池
        </ModuleToggle>
        <ModuleToggle pressed={showCalendar} onClick={() => toggleModule("showCalendar")}>
          月历
        </ModuleToggle>
      </div>

      <div className="dw-schedule-body">
        {showGantt &&
          (scheduled.length > 0 ? (
            <div
              className="ac-card dw-schedule-gantt"
              style={showCalendar ? { flexBasis: `${ganttRatio * 100}%` } : { flex: "1 1 auto" }}
            >
              {/* 时间刻度头：吸在甘特区顶部，任务多、内部滚动时仍看得到日期 */}
              <div className="dw-gantt-head sticky top-0 z-10 border-b border-line bg-surface/95 px-3 py-2 backdrop-blur-sm">
                <div className="dw-gantt-scale relative h-4">
                  {scale.ticks.map((t, i) => (
                    <span
                      key={i}
                      className="dw-gantt-tick absolute -translate-x-1/2 text-[11px] tabular-nums text-ink-faint"
                      style={{ left: `${pct(t)}%` }}
                    >
                      {fmtMD(t)}
                    </span>
                  ))}
                </div>
              </div>

              {groups.map((g) => (
                <div key={g.projectId} className="border-b border-line last:border-b-0">
                  {/* 只有一个项目时不重复项目名：小卡片里省下一行，多露一条任务 */}
                  {groups.length > 1 && (
                    <div className="bg-sunken/40 px-3 py-1 text-[11px] font-semibold text-ink-soft">
                      {g.projectName}
                    </div>
                  )}
                  <ul>
                    {g.bars.map((b) => {
                      const rangeLabel = `${b.task.startDate ?? "…"}→${b.task.dueDate ?? "…"}`;
                      return (
                        <li key={b.task.id} className="flex items-center px-3 py-0.5">
                          <Link
                            href={`/projects/${b.task.projectId}/tasks/${b.task.id}`}
                            className="dw-gantt-label shrink-0 truncate pr-2 text-xs text-ink hover:text-primary"
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
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-ink-soft">
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
            <div className="ac-card dw-schedule-gantt dw-schedule-empty text-xs text-ink-faint">
              尚无任务设了官方起止日——在项目里给任务排期后，时间线会出现在这里
            </div>
          ))}

        {showGantt && showCalendar && scheduled.length > 0 && (
          <TrackSplitter
            orientation="y"
            label="调整甘特与月历的高度比例"
            min={SCHEDULE_GANTT_RATIO_MIN}
            max={SCHEDULE_GANTT_RATIO_MAX}
            value={ganttRatio}
            onPreview={setGanttPreview}
            onCommit={commitGanttRatio}
            className="dw-schedule-split"
          />
        )}

        {showCalendar && (
          <div className="dw-cal-scroll">
            {/* 月历：标记任务官方起止（只读），并把任务安排到「我打算哪天做」的计划日 */}
            <WorkbenchCalendar
              tasks={tasks}
              plans={plans}
              today={today}
              showPool={showPool}
              poolRatio={poolRatio}
              poolRatioMin={SCHEDULE_POOL_RATIO_MIN}
              poolRatioMax={SCHEDULE_POOL_RATIO_MAX}
              onPoolRatioPreview={setPoolPreview}
              onPoolRatioCommit={commitPoolRatio}
            />

            {unscheduled.length > 0 && <UnscheduledList tasks={unscheduled} />}
          </div>
        )}

        {!showGantt && !showCalendar && (
          <p className="dw-schedule-empty text-xs text-ink-faint">
            甘特和月历都隐藏了——点上方开关重新显示。
          </p>
        )}
      </div>
    </section>
  );
}

function ModuleToggle({
  pressed,
  disabled,
  onClick,
  children,
}: {
  pressed: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="dw-schedule-toggle"
    >
      {children}
    </button>
  );
}

function UnscheduledList({ tasks }: { tasks: WorkbenchTask[] }) {
  return (
    <div className="ac-card dw-unscheduled p-3">
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
