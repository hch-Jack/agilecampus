/**
 * 日程表个人计划段的颜色。
 *
 * 只存**色板键**、不存 hex：配色跟着主题（浅色 / 项目页深色）自适应，也杜绝把用户输入
 * 当样式注入。缺省 / `null` = 跟随任务状态（待办灰、进行中主色、已完成黄），兼容旧数据。
 */

export const TASK_PLAN_COLORS = [
  { key: "blue", label: "蓝", chip: "bg-primary-soft text-primary", dot: "bg-primary" },
  { key: "green", label: "绿", chip: "bg-done/15 text-done", dot: "bg-done" },
  { key: "amber", label: "黄", chip: "bg-medium-soft text-medium", dot: "bg-medium" },
  { key: "orange", label: "橙", chip: "bg-accent-soft text-accent", dot: "bg-accent" },
  { key: "red", label: "红", chip: "bg-high-soft text-high", dot: "bg-high" },
  { key: "gray", label: "灰", chip: "bg-low-soft text-low", dot: "bg-low" },
] as const;

export type TaskPlanColor = (typeof TASK_PLAN_COLORS)[number]["key"];

/** zod 的 z.enum 要求非空元组 */
export const TASK_PLAN_COLOR_KEYS = TASK_PLAN_COLORS.map((c) => c.key) as [
  TaskPlanColor,
  ...TaskPlanColor[],
];

const BY_KEY = new Map<string, (typeof TASK_PLAN_COLORS)[number]>(
  TASK_PLAN_COLORS.map((c) => [c.key, c]),
);

export function isTaskPlanColor(value: unknown): value is TaskPlanColor {
  return typeof value === "string" && BY_KEY.has(value);
}

/** 没挑颜色时按任务状态兜底（与改造前的配色一致） */
export const TASK_STATUS_PLAN_CHIP: Record<string, string> = {
  todo: "bg-low-soft text-low",
  doing: "bg-primary-soft text-primary",
  done: "bg-medium-soft text-medium",
};

export function planColorChip(color?: string | null): string | null {
  return (color && BY_KEY.get(color)?.chip) || null;
}

export function planColorDot(color?: string | null): string | null {
  return (color && BY_KEY.get(color)?.dot) || null;
}

export function planColorLabel(color?: string | null): string | null {
  return (color && BY_KEY.get(color)?.label) || null;
}

/** chip 的最终配色：自定义颜色优先，否则跟随状态 */
export function planChipClass(color?: string | null, status?: string | null): string {
  return (
    planColorChip(color) ??
    (status ? TASK_STATUS_PLAN_CHIP[status] : undefined) ??
    TASK_STATUS_PLAN_CHIP.todo
  );
}
