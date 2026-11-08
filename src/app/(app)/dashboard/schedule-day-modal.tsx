"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { formatMonthDay, parseDay } from "@/lib/gantt";
import type { TaskPlanSegment } from "@/lib/task-plan";
import { TASK_STATUS_PLAN_CHIP, planColorDot } from "@/lib/task-plan-colors";
import type { WorkbenchTask } from "./workbench-board";
import { PlanColorPicker, type PlanColorValue } from "./plan-color-picker";

/** 当天落在我计划段里的条目（同一任务可能有多段都盖到这天） */
export type DayPlanEntry = { task: WorkbenchTask; seg: TaskPlanSegment };
/** 任务官方起止覆盖到的条目；kind 说明这天是开始、截止还是跨度中 */
export type DayOfficialEntry = { task: WorkbenchTask; kind: "start" | "due" | "span" };

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function weekdayOf(day: string): string {
  const ms = parseDay(day);
  return ms === null ? "" : WEEKDAY[new Date(ms).getUTCDay()];
}

function rangeText(seg: TaskPlanSegment): string {
  const a = formatMonthDay(parseDay(seg.start)!);
  return seg.start === seg.end ? a : `${a}→${formatMonthDay(parseDay(seg.end)!)}`;
}

const OFFICIAL_LABEL: Record<DayOfficialEntry["kind"], string> = {
  start: "官方开始",
  due: "官方截止",
  span: "官方跨度中",
};

/**
 * 当天安排详情弹窗：点月历某一天打开。
 *
 * 两栏：左边是「我的计划段」（可换色、可移除），右边/下面是任务官方起止（只读参照）。
 * 若任务池里选了任务，底部可直接把它排到这一天——颜色沿用任务池里选的颜色。
 * 弹窗 portal 到 body：卡片在拖拽/FLIP 动画期间可能有 transform，fixed 会被它当包含块。
 */
export function ScheduleDayModal({
  day,
  today,
  planned,
  official,
  selected,
  color,
  canWriteTask,
  onColorChange,
  onAddSelected,
  onRemove,
  onRecolor,
  onClose,
}: {
  day: string;
  today: string;
  planned: DayPlanEntry[];
  official: DayOfficialEntry[];
  selected: WorkbenchTask | null;
  color: PlanColorValue;
  canWriteTask: (task: WorkbenchTask) => boolean;
  onColorChange: (color: PlanColorValue) => void;
  onAddSelected: () => void;
  onRemove: (task: WorkbenchTask, seg: TaskPlanSegment) => void;
  onRecolor: (task: WorkbenchTask, seg: TaskPlanSegment, color: PlanColorValue) => void;
  onClose: () => void;
}) {
  // Esc 关闭 + 锁背景滚动（记住原值，别覆盖别处写的 overflow）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const isToday = day === today;
  const canAdd = !!selected && canWriteTask(selected);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-5"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${day} 的安排详情`}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-base font-semibold text-ink">
              {formatMonthDay(parseDay(day)!)} · {weekdayOf(day)}
              {isToday && (
                <span className="ml-2 rounded-full bg-primary px-1.5 py-0.5 align-middle text-[10px] font-normal text-white">
                  今天
                </span>
              )}
            </h2>
            <p className="mt-0.5 text-[11px] tabular-nums text-ink-faint">{day}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-1.5 text-lg leading-none text-ink-faint hover:text-ink"
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-ink-soft">
              我的安排（{planned.length}）
            </h3>
            {planned.length === 0 ? (
              <p className="text-xs text-ink-faint">这天还没有排任何计划。</p>
            ) : (
              <ul className="space-y-1.5">
                {planned.map(({ task, seg }) => {
                  const writable = canWriteTask(task);
                  return (
                    <li
                      key={`${task.id}~${seg.start}~${seg.end}`}
                      className="rounded-field border border-line px-2.5 py-2"
                    >
                      <div className="flex items-start gap-2">
                        <span
                          className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-sm ${
                            planColorDot(seg.color) ??
                            TASK_STATUS_PLAN_CHIP[task.status] ??
                            TASK_STATUS_PLAN_CHIP.todo
                          }`}
                          aria-hidden
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-ink" title={task.title}>
                            {task.title}
                          </p>
                          <p className="text-[11px] tabular-nums text-ink-faint">
                            {task.projectName} · 计划 {rangeText(seg)}
                          </p>
                        </div>
                        {writable && (
                          <button
                            type="button"
                            onClick={() => onRemove(task, seg)}
                            className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:bg-high-soft hover:text-high"
                            aria-label={`移除「${task.title}」这段计划`}
                            title="移除这段计划"
                          >
                            移除
                          </button>
                        )}
                      </div>
                      {writable && (
                        <div className="mt-1.5 flex items-center gap-1.5 pl-4">
                          <span className="text-[10px] text-ink-faint">颜色</span>
                          <PlanColorPicker
                            value={seg.color ?? "auto"}
                            onChange={(c) => onRecolor(task, seg, c)}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-ink-soft">
              任务官方起止（{official.length}）
            </h3>
            {official.length === 0 ? (
              <p className="text-xs text-ink-faint">没有任务的官方起止落在这天。</p>
            ) : (
              <ul className="space-y-1">
                {official.map(({ task, kind }) => (
                  <li key={task.id} className="flex items-center gap-2 rounded px-1 py-0.5">
                    <span className="h-1 w-4 shrink-0 rounded-full bg-ink/20" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-xs text-ink-soft" title={task.title}>
                      {task.title}
                    </span>
                    <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[10px] text-ink-faint">
                      {OFFICIAL_LABEL[kind]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <footer className="shrink-0 border-t border-line bg-sunken/40 px-4 py-2.5">
          {selected ? (
            canAdd ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-xs text-ink-soft" title={selected.title}>
                  把「{selected.title}」排到这天
                </span>
                <PlanColorPicker value={color} onChange={onColorChange} className="ml-auto" />
                <button
                  type="button"
                  onClick={onAddSelected}
                  className="ac-btn px-3 py-1.5 text-xs"
                >
                  排到这天
                </button>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">
                已选「{selected.title}」——只读角色不可计划。
              </p>
            )
          ) : (
            <p className="text-xs text-ink-faint">
              先在任务池选一条任务，就能把它排到这一天；颜色可在排期前选。
            </p>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
