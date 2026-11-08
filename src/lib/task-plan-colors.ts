/**
 * 日程表个人计划段的颜色。
 *
 * 只存**色板键或 #rrggbb**、不存任意 CSS：配色跟着主题（浅色 / 项目页深色）自适应，
 * 也杜绝把用户输入当样式注入。缺省 / `null` = 跟随任务状态，兼容旧数据。
 *
 * 色板刻意挑六个色相拉开的颜色——早先的琥珀 / 橙 / 红太接近，色点看起来像重复。
 * 旧的 orange / red / gray 仍可读可写（历史数据），只是不再出现在选择器里。
 */

import type { CSSProperties } from "react";

/** 选择器里展示的色板：六个色相明确区分的颜色 */
export const TASK_PLAN_COLORS = [
  { key: "blue", label: "蓝", hex: "#3b82f6" },
  { key: "green", label: "绿", hex: "#10b981" },
  { key: "amber", label: "黄", hex: "#f59e0b" },
  { key: "violet", label: "紫", hex: "#8b5cf6" },
  { key: "rose", label: "玫红", hex: "#f43f5e" },
  { key: "slate", label: "灰", hex: "#64748b" },
] as const;

/** 历史色板键：从选择器撤下，但旧计划段还要正常显示、旧客户端还能继续写 */
const LEGACY_PLAN_COLORS = [
  { key: "orange", label: "橙", hex: "#bf6a34" },
  { key: "red", label: "红", hex: "#b6482f" },
  { key: "gray", label: "灰", hex: "#6f7987" },
] as const;

export type PaletteColorKey = (typeof TASK_PLAN_COLORS)[number]["key"];
export type PlanColorKey =
  | PaletteColorKey
  | (typeof LEGACY_PLAN_COLORS)[number]["key"];

/** 存进 task_plans.color 的值：色板键（新旧）或自定义 #rrggbb */
export type TaskPlanColor = PlanColorKey | `#${string}`;

/** 自定义颜色的严格格式：只认六位 hex，避免样式注入 */
export const CUSTOM_PLAN_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** zod 的 z.enum 要求非空元组；只含当前色板（Agent 只从这里挑） */
export const TASK_PLAN_COLOR_KEYS = TASK_PLAN_COLORS.map((c) => c.key) as [
  PaletteColorKey,
  ...PaletteColorKey[],
];

const BY_KEY = new Map<string, { key: string; label: string; hex: string }>(
  [...TASK_PLAN_COLORS, ...LEGACY_PLAN_COLORS].map((c) => [c.key, c]),
);

/** 是不是能存进库的颜色：任意新旧色板键或 #rrggbb */
export function isTaskPlanColor(value: unknown): value is TaskPlanColor {
  return (
    typeof value === "string" &&
    (BY_KEY.has(value) || CUSTOM_PLAN_COLOR_RE.test(value))
  );
}

export function isCustomPlanColor(value: string): value is `#${string}` {
  return CUSTOM_PLAN_COLOR_RE.test(value);
}

/** 颜色对应的 hex；非法值返回 null（调用方自行回落到状态色） */
export function planColorHex(color?: string | null): string | null {
  if (!color) return null;
  const preset = BY_KEY.get(color);
  if (preset) return preset.hex;
  return CUSTOM_PLAN_COLOR_RE.test(color) ? color : null;
}

/** 没挑颜色时按任务状态兜底（与改造前的配色一致） */
export const TASK_STATUS_PLAN_CHIP: Record<string, string> = {
  todo: "bg-low-soft text-low",
  doing: "bg-primary-soft text-primary",
  done: "bg-medium-soft text-medium",
};

/** 状态兜底的 class；有计划颜色时不要再用它（内联样式会覆盖） */
export function planStatusChipClass(status?: string | null): string {
  return (status ? TASK_STATUS_PLAN_CHIP[status] : undefined) ?? TASK_STATUS_PLAN_CHIP.todo;
}

export function planColorLabel(color?: string | null): string | null {
  if (!color) return null;
  const preset = BY_KEY.get(color);
  if (preset) return preset.label;
  return CUSTOM_PLAN_COLOR_RE.test(color) ? "自定义" : null;
}

/** 色点用纯色填充；非法值返回 undefined，交给状态色 class */
export function planColorDotStyle(color?: string | null): CSSProperties | undefined {
  const hex = planColorHex(color);
  return hex ? { backgroundColor: hex } : undefined;
}

/**
 * chip 的配色：底色是同色相的淡色、文字是同色相向正文色过渡。
 * 用 color-mix + `var(--color-ink)` 而不是写死深色，浅色主题与宇宙深色主题都能读。
 */
export function planColorChipStyle(color?: string | null): CSSProperties | undefined {
  const hex = planColorHex(color);
  if (!hex) return undefined;
  return {
    backgroundColor: `color-mix(in srgb, ${hex} 16%, transparent)`,
    color: `color-mix(in srgb, ${hex} 68%, var(--color-ink))`,
  };
}
