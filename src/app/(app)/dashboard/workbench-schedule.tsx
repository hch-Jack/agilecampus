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
import { openAssistantWithPrompt } from "@/lib/right-panels";
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

/**
 * 「AI 排期」按钮放进对话里的提示。
 *
 * 注意这不是发给模型的用户消息：点按钮只是在助手气泡里说明能力与需要哪些信息，
 * 由用户自己写下要求、自己点发送，助手才开始排期——避免把提示词当用户指令直接执行。
 */
const SCHEDULE_AI_HINT = [
  "想让我帮你排工作台日程表？把你的要求告诉我就行，大概说说也可以：",
  "",
  "- 计划排在哪个时间段（从哪天到哪天）",
  "- 每天大概能投入多少时间，或最多排几个任务",
  "- 哪些任务优先，哪些可以往后放",
  "- 有没有必须避开的日子",
  "",
  "我会结合你的待办任务排一份草案——只改你自己的「打算哪天做」，不动任务的官方起止日；",
  "每段颜色也可以指定。草案确认后才落库。",
].join("\n");

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

  // 甘特默认收起：打开工作台先看月历与任务池，需要看整体跨度时再点开。
  // 任务池 / 月历仍默认展开；三者状态都随卡片 config 落库，用户的显式选择优先。
  const showGantt = config?.showGantt === true;
  const showPool = config?.showPool !== false;
  const showCalendar = config?.showCalendar !== false;

  function toggleModule(key: "showGantt" | "showPool" | "showCalendar") {
    const current = key === "showGantt" ? config?.showGantt === true : config?.[key] !== false;
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
    return <p className="dw-schedule-empty dw-meta px-1 text-ink-faint">暂无分配给你的任务。</p>;

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
      <div className="flex items-center justify-between gap-2">
        <h2 className="dw-title font-display font-semibold text-ink">日程表</h2>
        <button
          type="button"
          onClick={() => openAssistantWithPrompt(SCHEDULE_AI_HINT)}
          className="ac-btn-ghost dw-meta inline-flex shrink-0 items-center gap-1 px-2 py-0.5"
          title="让 AI 助手说明排期需要哪些要求，你写完要求再发送"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="M12 3l1.8 4.9 4.9 1.8-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3Z" />
            <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
          </svg>
          AI 排期
        </button>
      </div>
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
                      className="dw-gantt-tick dw-meta absolute -translate-x-1/2 tabular-nums text-ink-faint"
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
                    <div className="dw-meta bg-sunken/40 px-3 py-1 font-semibold text-ink-soft">
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
                            className="dw-gantt-label dw-meta shrink-0 truncate pr-2 text-ink hover:text-primary"
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
                              className={`dw-micro absolute top-0 flex h-5 items-center overflow-hidden rounded px-1.5 text-white ${
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
              <div className="dw-meta flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-ink-soft">
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
            <div className="ac-card dw-schedule-gantt dw-schedule-empty dw-meta text-ink-faint">
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
          <p className="dw-schedule-empty dw-meta text-ink-faint">
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
      <h3 className="dw-meta mb-2 font-semibold text-ink">未设官方起止（{tasks.length}）</h3>
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
