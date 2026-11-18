"use client";

import { useState, useOptimistic, useTransition } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { addMonth, calendarGrid, taskCoversDay, ymKey, ymOf, type YM } from "@/lib/calendar";
import { formatMonthDay, parseDay } from "@/lib/gantt";
import {
  addTaskPlanSegmentAction,
  clearTaskPlanAction,
  removeTaskPlanSegmentAction,
  setTaskPlanColorAction,
} from "@/app/(app)/projects/[projectId]/actions";
import type { TaskPlanSegment } from "@/lib/task-plan";
import {
  planColorChipStyle,
  planColorDotStyle,
  planColorLabel,
  planStatusChipClass,
  type TaskPlanColor,
} from "@/lib/task-plan-colors";
import type { WorkbenchTask } from "./workbench-board";
import { PlanColorPicker, type PlanColorValue } from "./plan-color-picker";
import {
  ScheduleDayModal,
  type DayOfficialEntry,
  type DayPlanEntry,
} from "./schedule-day-modal";
import { TrackSplitter } from "./track-splitter";

// 月历是日程表的一部分（无独立「日历」标题，由外层日程表承载）。
// 每格里两类标记：
//   · 任务官方起止（start→due）——灰色细条横跨区间，只读，只作参照
//   · 我自己的计划段（可多段：区间或单天）——彩色 chip，覆盖到的每一天都露一条；
//     颜色可选（按段存色板键），不选则跟随任务状态
// 计划段不动任务本体，只存个人记录（task_plans 表，一人一任务可多行）。
// 输入：点某一天弹「当天安排详情」；在任务池选任务后，详情弹窗底部可直接排到那天；
//       「区间」模式保留两次点击框一段的快捷操作。

// 与 TASK_WRITE_ROLES（lib/task.ts）同集：admin/student 可计划，teacher 只读
const WRITE_ROLES = ["admin", "student"];

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]; // 周一→周日

type Mode = "day" | "range";
type PlanPatch =
  | { op: "add"; taskId: string; seg: TaskPlanSegment }
  | { op: "remove"; taskId: string; seg: TaskPlanSegment }
  | { op: "recolor"; taskId: string; seg: TaskPlanSegment; color: TaskPlanColor | null }
  | { op: "clear"; taskId: string };

const segKey = (s: TaskPlanSegment) => `${s.start}~${s.end}`;
const segCovers = (s: TaskPlanSegment, day: string) =>
  taskCoversDay({ startDate: s.start, dueDate: s.end }, day);

function fmtSeg(s: TaskPlanSegment): string {
  const a = formatMonthDay(parseDay(s.start)!);
  return s.start === s.end ? a : `${a}→${formatMonthDay(parseDay(s.end)!)}`;
}

export function WorkbenchCalendar({
  tasks,
  plans,
  today,
  showPool = true,
  poolRatio,
  poolRatioMin = 0.2,
  poolRatioMax = 0.5,
  onPoolRatioPreview,
  onPoolRatioCommit,
}: {
  tasks: WorkbenchTask[];
  plans: Record<string, TaskPlanSegment[]>;
  today: string;
  /** 任务池是否显示（由日程表卡片的开关控制） */
  showPool?: boolean;
  /** 宽卡时任务池占正文宽度的比例；窄卡自动忽略 */
  poolRatio?: number;
  poolRatioMin?: number;
  poolRatioMax?: number;
  onPoolRatioPreview?: (ratio: number) => void;
  onPoolRatioCommit?: (ratio: number) => void;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<YM>(() => ymOf(today));
  const [mode, setMode] = useState<Mode>("day");
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  /** 新排期用的颜色；"auto" = 跟随任务状态 */
  const [planColor, setPlanColor] = useState<PlanColorValue>("auto");
  /** 打开「当天安排详情」的那一天 */
  const [openDay, setOpenDay] = useState<string | null>(null);
  const router = useRouter();

  const [optimisticPlans, patchPlan] = useOptimistic(
    plans,
    (current, p: PlanPatch) => {
      if (p.op === "clear") return { ...current, [p.taskId]: [] };
      const segs = current[p.taskId] ?? [];
      if (p.op === "add") {
        if (segs.some((s) => segKey(s) === segKey(p.seg))) return current; // 同段去重
        const next = [...segs, p.seg].sort((a, b) => (a.start < b.start ? -1 : 1));
        return { ...current, [p.taskId]: next };
      }
      if (p.op === "recolor") {
        const next = segs.map((s) => {
          if (segKey(s) !== segKey(p.seg)) return s;
          const base: TaskPlanSegment = { start: s.start, end: s.end };
          return p.color ? { ...base, color: p.color } : base;
        });
        return { ...current, [p.taskId]: next };
      }
      const next = segs.filter((s) => segKey(s) !== segKey(p.seg));
      return { ...current, [p.taskId]: next };
    },
  );

  if (tasks.length === 0) return null;

  const key = ymKey(view);
  const grid = calendarGrid(view);
  // 每天：计划段条目（彩 chip + 详情弹窗要用）+ 官方起止覆盖到的任务（灰条）
  const plannedEntriesOnDay: DayPlanEntry[][] = grid.map((day) =>
    tasks.flatMap((t) =>
      (optimisticPlans[t.id] ?? [])
        .filter((s) => segCovers(s, day))
        .map((seg) => ({ task: t, seg })),
    ),
  );
  // 格子里每任务只露一条（同任务的多段若重叠，详情弹窗里仍逐段列出）
  const plannedTasksOnDay = plannedEntriesOnDay.map((entries) => {
    const seen = new Set<string>();
    return entries.filter((e) => {
      if (seen.has(e.task.id)) return false;
      seen.add(e.task.id);
      return true;
    });
  });
  const officialOnDay = grid.map((day) => tasks.filter((t) => taskCoversDay(t, day)));

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const canPlan = !!selected && WRITE_ROLES.includes(selected.role);
  const canWriteTask = (t: WorkbenchTask) => WRITE_ROLES.includes(t.role);

  // 任务池：无段在前（最需安排），有段按最早段起始日升序
  const pool = [...tasks].sort((a, b) => {
    const aSegs = optimisticPlans[a.id] ?? [];
    const bSegs = optimisticPlans[b.id] ?? [];
    if (aSegs.length === 0 && bSegs.length > 0) return -1;
    if (bSegs.length === 0 && aSegs.length > 0) return 1;
    const aStart = aSegs[0]?.start ?? a.dueDate ?? "9999";
    const bStart = bSegs[0]?.start ?? b.dueDate ?? "9999";
    return aStart < bStart ? -1 : 1;
  });

  function colorOf(value: PlanColorValue): TaskPlanColor | undefined {
    return value === "auto" ? undefined : value;
  }

  function addSegment(start: string, end: string) {
    if (!selected || !WRITE_ROLES.includes(selected.role)) return;
    const t = selected;
    const seg: TaskPlanSegment =
      start <= end ? { start, end } : { start: end, end: start };
    const color = colorOf(planColor);
    if (color) seg.color = color;
    startTransition(async () => {
      setError(null);
      patchPlan({ op: "add", taskId: t.id, seg });
      const res = await addTaskPlanSegmentAction({
        taskId: t.id,
        projectId: t.projectId,
        start: seg.start,
        end: seg.end,
        color,
      });
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  function removeSegment(task: WorkbenchTask, seg: TaskPlanSegment) {
    if (!WRITE_ROLES.includes(task.role)) return;
    startTransition(async () => {
      setError(null);
      patchPlan({ op: "remove", taskId: task.id, seg });
      const res = await removeTaskPlanSegmentAction({
        taskId: task.id,
        projectId: task.projectId,
        start: seg.start,
        end: seg.end,
      });
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  function recolorSegment(
    task: WorkbenchTask,
    seg: TaskPlanSegment,
    value: PlanColorValue,
  ) {
    if (!WRITE_ROLES.includes(task.role)) return;
    const color = value === "auto" ? null : value;
    startTransition(async () => {
      setError(null);
      patchPlan({ op: "recolor", taskId: task.id, seg, color });
      const res = await setTaskPlanColorAction({
        taskId: task.id,
        projectId: task.projectId,
        start: seg.start,
        end: seg.end,
        color,
      });
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  function clearAll() {
    if (!selected || !WRITE_ROLES.includes(selected.role)) return;
    const t = selected;
    setRangeAnchor(null);
    startTransition(async () => {
      setError(null);
      patchPlan({ op: "clear", taskId: t.id });
      const res = await clearTaskPlanAction({ taskId: t.id, projectId: t.projectId });
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  function deselect() {
    setSelectedId(null);
    setRangeAnchor(null);
  }

  function onDayClick(day: string) {
    // 非本月天：先切到那个月，避免在别的月份里弹详情
    if (day.slice(0, 7) !== key) {
      setView(ymOf(day));
      return;
    }
    // 区间模式且选了可写任务：保留两次点击框一段的快捷操作（不弹窗）
    if (canPlan && mode === "range") {
      if (rangeAnchor === null) {
        setRangeAnchor(day);
        return;
      }
      if (day === rangeAnchor) {
        setRangeAnchor(null);
        return;
      }
      addSegment(rangeAnchor, day);
      setRangeAnchor(null);
      return;
    }
    setOpenDay(day);
  }

  const selectedSegs = selected ? optimisticPlans[selected.id] ?? [] : [];

  // 选中任务的排期设置。同一个元素渲染两处：宽卡插在选中任务正下方，
  // 窄卡（chip 带）放回池底——靠 dashboard.css 里的容器查询二选一显示。
  const poolControls =
    selected && canPlan ? (
      <div className="space-y-2">
        {/* 单天 / 区间 模式 */}
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => {
              setMode("day");
              setRangeAnchor(null);
            }}
            aria-pressed={mode === "day"}
            className={`ac-badge ${mode === "day" ? "bg-primary text-white" : "bg-surface text-ink-soft hover:bg-primary-soft"}`}
          >
            单天
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("range");
              setRangeAnchor(null);
            }}
            aria-pressed={mode === "range"}
            className={`ac-badge ${mode === "range" ? "bg-primary text-white" : "bg-surface text-ink-soft hover:bg-primary-soft"}`}
          >
            区间
          </button>
        </div>
        {/* 新排期的颜色（"自动" = 跟随任务状态） */}
        <div className="flex items-center gap-1.5">
          <span className="dw-meta text-ink-faint">新排期颜色</span>
          <PlanColorPicker value={planColor} onChange={setPlanColor} />
        </div>
        {/* 已有段：点 × 移除 */}
        {selectedSegs.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {selectedSegs.map((s) => (
              <button
                type="button"
                key={segKey(s)}
                onClick={() => removeSegment(selected, s)}
                style={planColorChipStyle(s.color)}
                className={`ac-badge ${s.color ? "" : planStatusChipClass(selected.status)} hover:brightness-95`}
                title="移除这段"
              >
                {fmtSeg(s)} ×
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {selectedSegs.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="ac-badge bg-high-soft text-high hover:brightness-95"
            >
              清除全部
            </button>
          )}
          <button
            type="button"
            onClick={deselect}
            className="ac-badge bg-surface text-ink-soft hover:bg-primary-soft"
          >
            取消
          </button>
        </div>
      </div>
    ) : null;

  const openDayIndex = openDay ? grid.indexOf(openDay) : -1;
  const openDayEntries = openDayIndex >= 0 ? plannedEntriesOnDay[openDayIndex] : [];
  const openDayOfficial: DayOfficialEntry[] =
    openDayIndex >= 0
      ? officialOnDay[openDayIndex].map((task) => ({
          task,
          kind:
            task.startDate === openDay
              ? "start"
              : task.dueDate === openDay
                ? "due"
                : "span",
        }))
      : [];

  return (
    <div className="dw-cal">
      <div className="dw-cal-toolbar flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <p className="dw-item font-display tabular-nums text-ink">
            {view.year} 年 {view.month} 月
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setView(addMonth(view, -1))}
              className="ac-badge bg-surface text-ink-soft hover:bg-primary-soft"
              aria-label="上一月"
            >
              ‹
            </button>
            <button
              type="button"
              onClick={() => setView(ymOf(today))}
              className="ac-badge bg-surface text-ink-soft hover:bg-primary-soft"
            >
              今
            </button>
            <button
              type="button"
              onClick={() => setView(addMonth(view, 1))}
              className="ac-badge bg-surface text-ink-soft hover:bg-primary-soft"
              aria-label="下一月"
            >
              ›
            </button>
          </div>
        </div>
        <p className="dw-meta text-ink-faint">
          {selected
            ? canPlan
              ? mode === "range" && rangeAnchor
                ? `区间起点 ${formatMonthDay(parseDay(rangeAnchor)!)}，再点结束日（点回起点取消）`
                : `已选「${selected.title}」—${mode === "day" ? "点某天看详情并排期" : "点两天框一段区间"}`
              : `已选「${selected.title}」—只读角色不可计划`
            : showPool
              ? "点某天看当天安排；从任务池点选任务后可排期"
              : "任务池已隐藏——点上方「任务池」开关重新显示"}
        </p>
      </div>

      {error && <p className="dw-body text-high">{error}</p>}

      <div
        className="dw-cal-body"
        style={{ "--dw-pool-basis": `${(poolRatio ?? 0.3) * 100}%` } as CSSProperties}
      >
        {/* 任务池：窄卡里横排成一条可左右滑的 chip 带，宽卡才恢复左侧竖栏 */}
        {showPool && (
          <div className="ac-card dw-cal-pool p-2">
            <h3 className="dw-meta font-semibold text-ink-soft">任务池（{pool.length}）</h3>
            <ul className="dw-cal-pool-list">
              {pool.map((t) => {
                const canWrite = WRITE_ROLES.includes(t.role);
                const isSel = t.id === selectedId;
                const segs = optimisticPlans[t.id] ?? [];
                // 已有计划段时，用它的颜色作圆点；没挑颜色才回落到状态色
                const dotStyle = planColorDotStyle(segs.find((s) => s.color)?.color);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => canWrite && (isSel ? deselect() : setSelectedId(t.id))}
                      disabled={!canWrite}
                      className={`dw-cal-pool-item dw-meta flex items-center gap-1.5 rounded px-2 py-1 text-left transition ${
                        isSel
                          ? "bg-primary-soft text-primary ring-1 ring-primary/50"
                          : canWrite
                            ? "hover:bg-surface text-ink"
                            : "text-ink-faint"
                      }`}
                      title={t.title}
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-sm ${
                          dotStyle ? "" : planStatusChipClass(t.status)
                        }`}
                        style={dotStyle}
                      />
                      <span className="truncate">{t.title}</span>
                      <span className="dw-cal-pool-meta dw-micro ml-auto shrink-0 tabular-nums text-ink-faint">
                        {segs.length ? `${segs.length} 段` : "未计划"}
                      </span>
                    </button>
                    {/* 宽卡竖栏：排期设置直接插在选中任务的正下方 */}
                    {isSel && poolControls && (
                      <div className="dw-cal-controls-inline">{poolControls}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* 窄卡 chip 带：放不下内联控件，仍收在任务池底部 */}
            {poolControls && <div className="dw-cal-controls-bottom">{poolControls}</div>}
          </div>
        )}

        {/* 宽卡时任务池是左栏，这条竖拖拽条改它的宽度占比（窄卡自动隐藏） */}
        {showPool && onPoolRatioPreview && onPoolRatioCommit && (
          <TrackSplitter
            orientation="x"
            label="调整任务池与月历的宽度比例"
            min={poolRatioMin}
            max={poolRatioMax}
            value={poolRatio}
            onPreview={onPoolRatioPreview}
            onCommit={onPoolRatioCommit}
            className="dw-cal-split"
          />
        )}

        {/* 月历网格 */}
        <div className="ac-card dw-cal-grid flex-1 p-3">
          <div className="dw-meta mb-1 grid grid-cols-7 gap-px text-center text-ink-faint">
            {WEEKDAYS.map((w) => (
              <span key={w} className="py-1">
                {w}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-px">
            {grid.map((day, i) => {
              const inMonth = day.slice(0, 7) === key;
              const isToday = day === today;
              const isAnchor = day === rangeAnchor;
              const planned = plannedTasksOnDay[i];
              const shownPlans = planned.slice(0, 3);
              const extraPlans = planned.length - shownPlans.length;
              // 官方灰条：跳过当天已计划的同一个任务，免得灰条与彩色 chip 重叠
              const official = officialOnDay[i].filter(
                (t) => !(optimisticPlans[t.id] ?? []).some((s) => segCovers(s, day)),
              );
              return (
                <button
                  type="button"
                  key={day}
                  onClick={() => onDayClick(day)}
                  title={
                    inMonth
                      ? canPlan && mode === "range"
                        ? "点一下选区间起点/终点"
                        : "点击查看当天安排详情"
                      : "跳到这个月"
                  }
                  className={`dw-cal-day flex flex-col border p-1 text-left align-top transition hover:bg-surface ${
                    isAnchor
                      ? "border-primary ring-1 ring-primary/60"
                      : "border-line"
                  } ${inMonth ? "bg-transparent" : "bg-sunken/30 text-ink-faint"}`}
                >
                  <span
                    className={`dw-meta mb-0.5 inline-block tabular-nums ${
                      isToday
                        ? "rounded-full bg-primary px-1.5 text-white"
                        : inMonth
                          ? "text-ink"
                          : "text-ink-faint"
                    }`}
                  >
                    {Number(day.slice(8))}
                  </span>
                  <div className="space-y-0.5">
                    {shownPlans.map(({ task: t, seg }) => {
                      const overdue =
                        t.status !== "done" && t.dueDate !== null && t.dueDate < today;
                      // 用户自己挑的颜色优先于逾期红：逾期只用一圈红边提示，
                      // 否则逾期任务的玫红/青/紫等颜色全被红色盖掉，看起来「只有几种颜色」。
                      return (
                        <span
                          key={t.id}
                          style={planColorChipStyle(seg.color)}
                          className={`dw-micro block truncate rounded px-1 ${
                            seg.color
                              ? overdue
                                ? "ring-1 ring-high/50"
                                : ""
                              : overdue
                                ? "bg-high-soft text-high"
                                : planStatusChipClass(t.status)
                          }`}
                          title={`计划：${t.title}（${planColorLabel(seg.color) ?? "跟随状态"}）${
                            overdue ? " · 已逾期" : ""
                          }`}
                        >
                          {t.title}
                        </span>
                      );
                    })}
                    {extraPlans > 0 && (
                      <span className="dw-micro block text-ink-faint">+{extraPlans}</span>
                    )}
                  </div>
                  {/* 官方起止细条：横跨区间每天都露一段，连起来即跨度 */}
                  {official.length > 0 && (
                    <div className="mt-auto flex flex-col gap-px pt-1">
                      {official.slice(0, 2).map((t) => (
                        <span
                          key={t.id}
                          className="h-1 rounded-full bg-ink/20"
                          title={`官方起止：${t.title} ${t.startDate ?? "…"}→${t.dueDate ?? "…"}`}
                        />
                      ))}
                      {official.length > 2 && (
                        <span className="dw-micro leading-none text-ink-faint">
                          +{official.length - 2}
                        </span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {openDay && (
        <ScheduleDayModal
          day={openDay}
          today={today}
          planned={openDayEntries}
          official={openDayOfficial}
          selected={selected}
          color={planColor}
          canWriteTask={canWriteTask}
          onColorChange={setPlanColor}
          onAddSelected={() => addSegment(openDay, openDay)}
          onRemove={removeSegment}
          onRecolor={recolorSegment}
          onClose={() => setOpenDay(null)}
        />
      )}
    </div>
  );
}
