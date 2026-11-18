"use client";

import { useEffect, useRef } from "react";
import {
  TASK_PLAN_COLORS,
  isCustomPlanColor,
  type TaskPlanColor,
} from "@/lib/task-plan-colors";

/** `"auto"` = 跟随任务状态（库里存 NULL） */
export type PlanColorValue = TaskPlanColor | "auto";

const CUSTOM_FALLBACK = "#64748b";

/**
 * 计划段颜色选择器：一排小色点 + 自定义取色，「自动」跟随任务状态。
 * 键盘可达（原生 button / color input + aria-pressed），选中态用外圈 ring 标出。
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
  const custom = isCustomPlanColor(value) ? value : CUSTOM_FALLBACK;
  const inputRef = useRef<HTMLInputElement>(null);
  // React 的 onChange 对 color input 绑的是 input 事件——拖动取色器时会连发，
  // 每一下都落一次库太重。改听原生 change（关掉取色面板才触发）只提交最终值。
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const commit = () => {
      // 原生取色器给的是 #rrggbb；仍走一遍校验，别把异常串存进库
      if (isCustomPlanColor(el.value)) onChange(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [onChange]);
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
          className={`h-5 w-5 rounded-full transition ${
            value === c.key ? "ring-2 ring-ink/50 ring-offset-1" : "opacity-80 hover:opacity-100"
          }`}
          style={{ backgroundColor: c.hex }}
        />
      ))}
      {/* 自定义颜色：点开系统取色器；选中自定义色时直接用当前颜色填充 */}
      <label
        title="自定义颜色"
        aria-label="自定义颜色"
        className={`relative h-5 w-5 cursor-pointer overflow-hidden rounded-full border border-line transition ${
          isCustomPlanColor(value) ? "ring-2 ring-ink/50 ring-offset-1" : "opacity-80 hover:opacity-100"
        }`}
        style={
          isCustomPlanColor(value)
            ? { backgroundColor: value }
            : {
                background:
                  "conic-gradient(#f43f5e, #f59e0b, #10b981, #3b82f6, #8b5cf6, #f43f5e)",
              }
        }
      >
        <input
          ref={inputRef}
          type="color"
          defaultValue={custom}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          aria-label="自定义颜色"
        />
      </label>
    </div>
  );
}
