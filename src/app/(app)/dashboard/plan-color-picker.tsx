"use client";

import { TASK_PLAN_COLORS, type TaskPlanColor } from "@/lib/task-plan-colors";

/** `"auto"` = 跟随任务状态（库里存 NULL） */
export type PlanColorValue = TaskPlanColor | "auto";

/**
 * 计划段颜色选择器：一排小色点，「自动」跟随任务状态。
 * 键盘可达（原生 button + aria-pressed），选中态用外圈 ring 标出。
 */
export function PlanColorPicker({
  value,
  onChange,
  autoLabel = "自动",
  className = "",
}: {
  value: PlanColorValue;
  onChange: (value: PlanColorValue) => void;
  autoLabel?: string;
  className?: string;
}) {
  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} role="group" aria-label="计划颜色">
      <button
        type="button"
        onClick={() => onChange("auto")}
        aria-pressed={value === "auto"}
        title={`${autoLabel}（跟随任务状态）`}
        aria-label={`${autoLabel}（跟随任务状态）`}
        className={`grid h-5 w-5 place-items-center rounded-full border border-line bg-surface text-[9px] text-ink-faint transition ${
          value === "auto" ? "ring-2 ring-ink/40 ring-offset-1" : "hover:border-ink-faint"
        }`}
      >
        自
      </button>
      {TASK_PLAN_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange(c.key)}
          aria-pressed={value === c.key}
          title={c.label}
          aria-label={c.label}
          className={`h-5 w-5 rounded-full ${c.dot} transition ${
            value === c.key ? "ring-2 ring-ink/50 ring-offset-1" : "opacity-75 hover:opacity-100"
          }`}
        />
      ))}
    </div>
  );
}
