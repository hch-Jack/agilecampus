"use client";

import { useState, useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { addMonth, calendarGrid, taskCoversDay, ymKey, ymOf, type YM } from "@/lib/calendar";
import { formatMonthDay, parseDay } from "@/lib/gantt";
import {
  addTaskPlanSegmentAction,
  clearTaskPlanAction,
  removeTaskPlanSegmentAction,
} from "@/app/(app)/projects/[projectId]/actions";
import type { TaskPlanSegment } from "@/lib/task-plan";
import type { WorkbenchTask } from "./workbench-board";

// 月历是日程表的一部分（无独立「日历」标题，由外层日程表承载）。
// 每格里两类标记：
//   · 任务官方起止（start→due）——灰色细条横跨区间，只读，只作参照
//   · 我自己的计划段（可多段：区间或单天）——彩色 chip，覆盖到的每一天都露一条
// 计划段不动任务本体，只存个人记录（task_plans 表，一人一任务可多行）。
// 输入：左侧选任务 → 「单天」模式点某天加单天段；「区间」模式点两天框一段区间；
//       已有段在任务池下方以 × chip 列出，点 × 移除该段，「清除全部」清空。

// 与 TASK_WRITE_ROLES（lib/task.ts）同集：admin/student 可计划，teacher 只读
const WRITE_ROLES = ["admin", "student"];

// 计划 chip 的软色（浅底深字，按状态）
const STATUS_SOFT: Record<string, string> = {
  todo: "bg-low-soft text-low",
  doing: "bg-primary-soft text-primary",
  done: "bg-medium-soft text-medium",
};

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"]; // 周一→周日

type Mode = "day" | "range";
type PlanPatch =
  | { op: "add"; taskId: string; seg: TaskPlanSegment }
  | { op: "remove"; taskId: string; seg: TaskPlanSegment }
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
}: {
  tasks: WorkbenchTask[];
  plans: Record<string, TaskPlanSegment[]>;
  today: string;
}) {
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<YM>(() => ymOf(today));
  const [mode, setMode] = useState<Mode>("day");
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
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
      const next = segs.filter((s) => segKey(s) !== segKey(p.seg));
      return { ...current, [p.taskId]: next };
    },
  );

  if (tasks.length === 0) return null;

  const key = ymKey(view);
  const grid = calendarGrid(view);
  // 每天：计划段覆盖到的任务（彩色 chip）+ 官方起止覆盖到的任务（灰条）
  const plannedOnDay = grid.map((day) =>
    tasks.filter((t) => (optimisticPlans[t.id] ?? []).some((s) => segCovers(s, day))),
  );
  const officialOnDay = grid.map((day) => tasks.filter((t) => taskCoversDay(t, day)));

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const canPlan = !!selected && WRITE_ROLES.includes(selected.role);

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

  function addSegment(start: string, end: string) {
    if (!selected || !WRITE_ROLES.includes(selected.role)) return;
    const t = selected;
    const seg: TaskPlanSegment = start <= end ? { start, end } : { start: end, end: start };
    startTransition(async () => {
      setError(null);
      patchPlan({ op: "add", taskId: t.id, seg });
      const res = await addTaskPlanSegmentAction({
        taskId: t.id,
        projectId: t.projectId,
        start: seg.start,
        end: seg.end,
      });
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  function removeSegment(seg: TaskPlanSegment) {
    if (!selected || !WRITE_ROLES.includes(selected.role)) return;
    const t = selected;
    startTransition(async () => {
      setError(null);
      patchPlan({ op: "remove", taskId: t.id, seg });
      const res = await removeTaskPlanSegmentAction({
        taskId: t.id,
        projectId: t.projectId,
        start: seg.start,
        end: seg.end,
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
    // 没选任务或只读：点非本月天切到那个月
    if (!canPlan) {
      if (day.slice(0, 7) !== key) setView(ymOf(day));
      return;
    }
    if (mode === "day") {
      addSegment(day, day);
      return;
    }
    // 区间模式：第一次点设起点，第二次点（不同天）成段，点回起点取消
    if (rangeAnchor === null) {
      setRangeAnchor(day);
      if (day.slice(0, 7) !== key) setView(ymOf(day));
      return;
    }
    if (day === rangeAnchor) {
      setRangeAnchor(null);
      return;
    }
    addSegment(rangeAnchor, day);
    setRangeAnchor(null);
    if (day.slice(0, 7) !== key) setView(ymOf(day));
  }

  const selectedSegs = selected ? optimisticPlans[selected.id] ?? [] : [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <p className="font-display text-sm tabular-nums text-ink">
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
        <p className="text-xs text-ink-faint">
          {selected
            ? canPlan
              ? mode === "range" && rangeAnchor
                ? `区间起点 ${formatMonthDay(parseDay(rangeAnchor)!)}，再点结束日（点回起点取消）`
                : `已选「${selected.title}」—${mode === "day" ? "点某天加单天段" : "点两天框一段区间"}`
              : `已选「${selected.title}」—只读角色不可计划`
            : "从左侧点选任务，再点某天排计划"}
        </p>
      </div>

      {error && <p className="text-sm text-high">{error}</p>}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 任务池 */}
        <div className="ac-card max-h-80 space-y-1 overflow-y-auto p-3 lg:w-64 lg:max-h-none lg:shrink-0">
          <h3 className="text-xs font-semibold text-ink-soft">任务池（{pool.length}）</h3>
          <ul className="space-y-1">
            {pool.map((t) => {
              const canWrite = WRITE_ROLES.includes(t.role);
              const isSel = t.id === selectedId;
              const segs = optimisticPlans[t.id] ?? [];
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => canWrite && (isSel ? deselect() : setSelectedId(t.id))}
                    disabled={!canWrite}
                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition ${
                      isSel
                        ? "bg-primary-soft text-primary ring-1 ring-primary/50"
                        : canWrite
                          ? "hover:bg-surface text-ink"
                          : "text-ink-faint"
                    }`}
                    title={t.title}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-sm ${STATUS_SOFT[t.status] ?? "bg-low-soft"}`}
                    />
                    <span className="truncate">{t.title}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[10px] text-ink-faint">
                      {segs.length ? `${segs.length} 段` : "未计划"}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && canPlan && (
            <div className="space-y-2 pt-2">
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
              {/* 已有段：点 × 移除 */}
              {selectedSegs.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedSegs.map((s) => (
                    <button
                      type="button"
                      key={segKey(s)}
                      onClick={() => removeSegment(s)}
                      className="ac-badge bg-primary-soft text-primary hover:brightness-95"
                      title="移除这段"
                    >
                      {fmtSeg(s)} ×
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
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
          )}
        </div>

        {/* 月历网格 */}
        <div className="ac-card flex-1 p-3">
          <div className="mb-1 grid grid-cols-7 gap-px text-center text-[11px] text-ink-faint">
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
              const planned = plannedOnDay[i];
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
                  className={`flex min-h-20 flex-col border p-1 text-left align-top transition hover:bg-surface ${
                    isAnchor
                      ? "border-primary ring-1 ring-primary/60"
                      : "border-line"
                  } ${inMonth ? "bg-transparent" : "bg-sunken/30 text-ink-faint"}`}
                >
                  <span
                    className={`mb-0.5 inline-block text-[11px] tabular-nums ${
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
                    {shownPlans.map((t) => {
                      const overdue =
                        t.status !== "done" && t.dueDate !== null && t.dueDate < today;
                      return (
                        <span
                          key={t.id}
                          className={`block truncate rounded px-1 text-[10px] ${
                            overdue
                              ? "bg-high-soft text-high"
                              : STATUS_SOFT[t.status] ?? "bg-low-soft text-low"
                          }`}
                          title={`计划：${t.title}`}
                        >
                          {t.title}
                        </span>
                      );
                    })}
                    {extraPlans > 0 && (
                      <span className="block text-[10px] text-ink-faint">+{extraPlans}</span>
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
                        <span className="text-[9px] leading-none text-ink-faint">
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
    </div>
  );
}
