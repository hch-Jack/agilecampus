"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  buildTimeScale,
  formatMonthDay,
  parseDay,
} from "@/lib/gantt";
import {
  BAR_HEIGHT,
  BAR_MIN_WIDTH_PX,
  ROW_HEIGHT,
  buildTaskForest,
  collectScheduledSpans,
  computeVisibleEdges,
  dependencyNeighbors,
  flattenChartRows,
  flattenUnscheduledRows,
  type ChartRow,
  type Dependency,
  type GraphTask,
} from "@/lib/relationship-graph";

type MilestoneInput = { id: string; title: string; targetDate: string | null };

type RelationshipGraphProps = {
  projectId: string;
  todayMs: number;
  projectStartDate: string | null;
  projectEndDate: string | null;
  tasks: GraphTask[];
  milestones: MilestoneInput[];
  dependencies: Dependency[];
};

const STATUS_BAR: Record<string, string> = {
  todo: "bg-todo",
  doing: "bg-doing",
  done: "bg-done",
};
const STATUS_TEXT: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
};
// 左侧标题列固定宽度，与 lineLeft / SVG 覆盖层的偏移保持一致（w-56 = 14rem）
const LABEL_WIDTH_REM = 14;

function dayLabel(s: string | null): string {
  const ms = parseDay(s);
  return ms === null ? "…" : formatMonthDay(ms);
}

function dateLabel(task: GraphTask): string {
  return `${dayLabel(task.startDate)} → ${dayLabel(task.dueDate)}`;
}

export function RelationshipGraph({
  projectId,
  todayMs,
  projectStartDate,
  projectEndDate,
  tasks,
  milestones,
  dependencies,
}: RelationshipGraphProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set());
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const timeAreaRef = useRef<HTMLDivElement>(null);

  const forest = useMemo(() => buildTaskForest(tasks), [tasks]);
  const chartRows = useMemo(
    () => flattenChartRows(forest, collapsedIds, todayMs),
    [forest, collapsedIds, todayMs],
  );
  const unscheduledRows = useMemo(() => flattenUnscheduledRows(forest), [forest]);
  // 刻度用全量已排期任务，折叠不改变时间轴
  const allSpans = useMemo(() => collectScheduledSpans(forest), [forest]);

  const scale = useMemo(
    () =>
      buildTimeScale({
        spans: allSpans,
        milestoneTargetDates: milestones.map((m) => m.targetDate),
        projectStartDate,
        projectEndDate,
        todayMs,
      }),
    [allSpans, milestones, projectStartDate, projectEndDate, todayMs],
  );

  const datedMilestones = useMemo(
    () =>
      milestones.flatMap((m) => {
        const ms = parseDay(m.targetDate);
        return ms === null ? [] : [{ id: m.id, title: m.title, ms }];
      }),
    [milestones],
  );

  const edges = useMemo(
    () =>
      computeVisibleEdges({
        dependencies,
        rows: chartRows,
        min: scale.min,
        span: scale.span,
        chartWidth,
      }),
    [dependencies, chartRows, scale.min, scale.span, chartWidth],
  );

  const chartVisible = chartRows.length > 0;

  // 测量时间车道宽度：ResizeObserver 首次回调异步触发，避免 effect 内同步 setState。
  // 未测到前 chartWidth=0、不画依赖边，SSR 与首帧客户端都渲染同样的内容。
  useEffect(() => {
    const el = timeAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.getBoundingClientRect().width;
      setChartWidth(Math.floor(width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [chartVisible]);

  const activeHoveredId =
    hoveredId && chartRows.some((r) => r.task.id === hoveredId) ? hoveredId : null;
  const relatedIds = useMemo(
    () => dependencyNeighbors(dependencies, activeHoveredId),
    [dependencies, activeHoveredId],
  );
  const hasRelated = activeHoveredId !== null && relatedIds.size > 1;

  function toggleCollapsed(id: string) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const lineLeft = (pct: number) =>
    `calc(${LABEL_WIDTH_REM}rem + (100% - ${LABEL_WIDTH_REM}rem) * ${pct / 100})`;
  const todayPct = scale.pct(todayMs);

  if (tasks.length === 0) {
    return (
      <div className="ac-card p-8 text-center text-sm text-ink-soft">
        项目还没有任务。先在项目页创建任务，再回来看关系图。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {chartVisible ? (
        <div className="ac-card isolate overflow-hidden" role="region" aria-label="任务关系甘特图">
          {/* isolate：卡内 z-30 的吸附标签列只在卡内比较，滚到顶栏下方时不再盖住导航 */}
          <p className="sr-only">
            关系图：{chartRows.length} 个已排期任务，按父子层级排列；横条的位置和宽度表示起止日期；
            箭头表示前置任务到后置任务的依赖。点击任务可查看详情。
          </p>

          <div className="overflow-x-auto overscroll-x-contain">
            <div className="min-w-[52rem]">
              {/* 时间刻度 */}
              <div className="flex h-8 border-b border-line bg-sunken/60">
                <div className="sticky left-0 z-30 flex w-56 shrink-0 items-center border-r border-line graph-sticky bg-surface px-2 text-[11px] text-ink-faint">
                  任务 / 子任务
                </div>
                <div ref={timeAreaRef} className="relative flex-1">
                  {scale.ticks.map((t, i) => (
                    <span
                      key={i}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-[11px] tabular-nums text-ink-faint"
                      style={{ left: `${scale.pct(t)}%` }}
                    >
                      {formatMonthDay(t)}
                    </span>
                  ))}
                </div>
              </div>

              {/* 里程碑带 */}
              {datedMilestones.length > 0 && (
                <div className="flex h-6 border-b border-line bg-sunken/30">
                  <div className="sticky left-0 z-30 flex w-56 shrink-0 items-center border-r border-line graph-sticky bg-surface px-2 text-[10px] text-ink-faint">
                    里程碑
                  </div>
                  <div className="relative flex-1">
                    {datedMilestones.map((m, i) => (
                      <span
                        key={m.id}
                        className="absolute max-w-24 -translate-x-1/2 truncate text-[10px] text-primary"
                        style={{
                          left: `${scale.pct(m.ms)}%`,
                          top: i % 2 === 0 ? 2 : 13,
                        }}
                        title={m.title}
                      >
                        {m.title}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* 行 + 全高参考线 + 依赖边覆盖层 */}
              <div className="relative">
                {todayPct >= 0 && todayPct <= 100 && (
                  <div
                    className="pointer-events-none absolute inset-y-0 z-0 w-px bg-accent/70"
                    style={{ left: lineLeft(todayPct) }}
                    aria-hidden
                  />
                )}
                {datedMilestones.map((m) => (
                  <div
                    key={m.id}
                    className="pointer-events-none absolute inset-y-0 z-0 w-0 border-l border-dashed border-primary/50"
                    style={{ left: lineLeft(scale.pct(m.ms)) }}
                    title={m.title}
                    aria-hidden
                  />
                ))}

                <ul>
                  {chartRows.map((row) => (
                    <ChartRowView
                      key={row.task.id}
                      row={row}
                      projectId={projectId}
                      dimmed={hasRelated && !relatedIds.has(row.task.id)}
                      related={activeHoveredId !== null && relatedIds.has(row.task.id)}
                      onHover={setHoveredId}
                      onToggleCollapsed={toggleCollapsed}
                      scalePct={scale.pct}
                    />
                  ))}
                </ul>

                {chartWidth > 0 && (
                  <svg
                    className="pointer-events-none absolute z-20 overflow-visible"
                    style={{
                      left: `${LABEL_WIDTH_REM}rem`,
                      top: 0,
                      width: chartWidth,
                      height: chartRows.length * ROW_HEIGHT,
                    }}
                    aria-hidden="true"
                    focusable="false"
                  >
                    <defs>
                      {/* 箭头朝向写死在 marker 上（orient 0 = 尖朝右 / 180 = 尖朝左），
                          按边的前向/后向选择，不靠路径末端切线——即使末段退化也永不反向。
                          refX=0：三角底边对齐路径终点（线停在底边），
                          尖端沿朝向再走 8px，正好贴在横条边缘上 */}
                      <marker
                        id="graph-dep-arrow-r"
                        viewBox="0 0 8 8"
                        refX="0"
                        refY="4"
                        markerWidth="8"
                        markerHeight="8"
                        markerUnits="userSpaceOnUse"
                        orient="0"
                      >
                        <path d="M0,0 L8,4 L0,8 z" className="fill-ink-faint" />
                      </marker>
                      <marker
                        id="graph-dep-arrow-r-hot"
                        viewBox="0 0 8 8"
                        refX="0"
                        refY="4"
                        markerWidth="8"
                        markerHeight="8"
                        markerUnits="userSpaceOnUse"
                        orient="0"
                      >
                        <path d="M0,0 L8,4 L0,8 z" className="fill-accent" />
                      </marker>
                      <marker
                        id="graph-dep-arrow-l"
                        viewBox="0 0 8 8"
                        refX="0"
                        refY="4"
                        markerWidth="8"
                        markerHeight="8"
                        markerUnits="userSpaceOnUse"
                        orient="180"
                      >
                        <path d="M0,0 L8,4 L0,8 z" className="fill-ink-faint" />
                      </marker>
                      <marker
                        id="graph-dep-arrow-l-hot"
                        viewBox="0 0 8 8"
                        refX="0"
                        refY="4"
                        markerWidth="8"
                        markerHeight="8"
                        markerUnits="userSpaceOnUse"
                        orient="180"
                      >
                        <path d="M0,0 L8,4 L0,8 z" className="fill-accent" />
                      </marker>
                    </defs>
                    {edges.map((edge) => {
                      const hot =
                        activeHoveredId !== null &&
                        (edge.predecessorId === activeHoveredId ||
                          edge.successorId === activeHoveredId);
                      const marker = edge.backward
                        ? hot
                          ? "url(#graph-dep-arrow-l-hot)"
                          : "url(#graph-dep-arrow-l)"
                        : hot
                          ? "url(#graph-dep-arrow-r-hot)"
                          : "url(#graph-dep-arrow-r)";
                      return (
                        <path
                          key={`${edge.predecessorId}-${edge.successorId}`}
                          d={edge.path}
                          fill="none"
                          strokeWidth={1.25}
                          className={
                            hot ? "stroke-accent" : "stroke-ink-faint opacity-60"
                          }
                          markerEnd={marker}
                        />
                      );
                    })}
                  </svg>
                )}
              </div>
            </div>
          </div>

          {/* 图例 */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-[11px] text-ink-soft">
            <Legend cls="bg-todo" label="待办" />
            <Legend cls="bg-doing" label="进行中" />
            <Legend cls="bg-done" label="已完成" />
            <Legend cls="bg-high" label="逾期" />
            <span className="flex items-center gap-1">
              <svg width="20" height="8" aria-hidden="true">
                <line x1="0" y1="4" x2="15" y2="4" stroke="currentColor" strokeWidth="1.2" />
                <path d="M15 1 L20 4 L15 7 z" fill="currentColor" />
              </svg>
              依赖（前置 → 后置）
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-3 w-px bg-accent/70" /> 今日
            </span>
            {datedMilestones.length > 0 && (
              <span className="flex items-center gap-1">
                <span className="inline-block h-3 w-0 border-l border-dashed border-primary/60" />
                里程碑
              </span>
            )}
            <span className="ml-auto tabular-nums">
              显示 {edges.length} / {dependencies.length} 条依赖
            </span>
          </div>
        </div>
      ) : (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          尚无已排期任务——给任务填上起始日或截止日，即可在此排成关系图。
        </div>
      )}

      {unscheduledRows.length > 0 && (
        <section className="ac-card p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">
            未排期（{unscheduledRows.length}）
          </h2>
          <p className="mb-2 text-xs text-ink-faint">
            这些任务没有起始日和截止日，未绘制在时间轴上。
          </p>
          <ul className="space-y-1">
            {unscheduledRows.map(({ task, depth }) => (
              <li
                key={task.id}
                className="flex items-center gap-2 text-xs"
                style={{ paddingLeft: Math.min(depth, 8) * 16 }}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    STATUS_BAR[task.status] ?? "bg-todo"
                  }`}
                  aria-hidden
                />
                <Link
                  href={`/projects/${projectId}/tasks/${task.id}`}
                  className="truncate text-ink hover:text-primary"
                >
                  {task.title}
                </Link>
                <span className="shrink-0 text-ink-faint">未填日期</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ChartRowView({
  row,
  projectId,
  dimmed,
  related,
  onHover,
  onToggleCollapsed,
  scalePct,
}: {
  row: ChartRow;
  projectId: string;
  dimmed: boolean;
  related: boolean;
  onHover: (id: string | null) => void;
  onToggleCollapsed: (id: string) => void;
  scalePct: (ms: number) => number;
}) {
  const leftPct = scalePct(row.span.start);
  const widthPct = Math.max(scalePct(row.span.end) - leftPct, 1.5);
  const statusLabel = STATUS_TEXT[row.task.status] ?? row.task.status;
  const title = `${row.task.title} · ${dateLabel(row.task)} · ${statusLabel}${
    row.overdue ? " · 逾期" : ""
  }`;

  return (
    <li
      style={{ height: ROW_HEIGHT }}
      className={`flex border-b border-line/60 last:border-b-0 ${
        related ? "bg-primary-soft/30" : ""
      }`}
      onMouseEnter={() => onHover(row.task.id)}
      onMouseLeave={() => onHover(null)}
      onFocusCapture={() => onHover(row.task.id)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          onHover(null);
        }
      }}
    >
      <div
        className="sticky left-0 z-30 flex h-full w-56 shrink-0 items-center gap-1.5 border-r border-line graph-sticky bg-surface px-2"
        style={{ paddingLeft: 8 + Math.min(row.depth, 8) * 16 }}
      >
        {row.hasScheduledDescendants ? (
          <button
            type="button"
            onClick={() => onToggleCollapsed(row.task.id)}
            aria-expanded={!row.collapsed}
            aria-label={`${row.collapsed ? "展开" : "折叠"} ${row.task.title} 的子任务`}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-ink-faint hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
          >
            <svg
              viewBox="0 0 12 12"
              className={`h-3 w-3 transition-transform ${
                row.collapsed ? "-rotate-90" : ""
              }`}
              aria-hidden="true"
            >
              <path
                d="M2 4 L6 8 L10 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}

        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            row.overdue ? "bg-high" : STATUS_BAR[row.task.status] ?? "bg-todo"
          }`}
          aria-hidden
        />

        <Link
          href={`/projects/${projectId}/tasks/${row.task.id}`}
          className="min-w-0 flex-1"
          title={row.task.title}
          aria-label={`${row.task.title}，${statusLabel}${
            row.overdue ? "，逾期" : ""
          }，${dateLabel(row.task)}`}
        >
          <span className="block truncate text-xs text-ink">{row.task.title}</span>
          <span
            className={`block truncate text-[10px] tabular-nums ${
              row.overdue ? "text-high" : "text-ink-faint"
            }`}
          >
            {dateLabel(row.task)}
            {row.overdue && " · 逾期"}
          </span>
        </Link>

        {row.descendantCount > 0 && (
          <span
            className="ac-badge shrink-0 bg-sunken text-ink-soft"
            title={
              row.collapsed
                ? `已隐藏 ${row.hiddenScheduledCount} 个已排期子任务`
                : `共 ${row.descendantCount} 个子任务`
            }
          >
            {row.collapsed ? `+${row.hiddenScheduledCount}` : row.descendantCount}
          </span>
        )}
      </div>

      <div className="relative flex-1">
        <Link
          href={`/projects/${projectId}/tasks/${row.task.id}`}
          tabIndex={-1}
          aria-label={`打开任务：${row.task.title}`}
          title={title}
          className={`absolute z-10 rounded outline-offset-1 transition-opacity ${
            row.overdue ? "bg-high" : STATUS_BAR[row.task.status] ?? "bg-todo"
          } ${dimmed ? "opacity-35" : ""} ${
            related ? "outline outline-2 outline-accent" : ""
          }`}
          style={{
            left: `${leftPct}%`,
            width: `max(${widthPct}%, ${BAR_MIN_WIDTH_PX}px)`,
            top: (ROW_HEIGHT - BAR_HEIGHT) / 2,
            height: BAR_HEIGHT,
          }}
        />
      </div>
    </li>
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
