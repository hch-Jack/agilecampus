// 任务状态/优先级的单一事实源：枚举值、中文文案、徽章配色、筛选项。
// 此前在 task-card / filter-bar / subtask-list / 任务详情页 / workbench-board /
// draft-cards / relationship-graph / attachment-center / lib/task.ts 各自复制，
// 改文案或配色要同步多处——收敛于此，各处 import。
// 无 IO、无 React、无服务端依赖：client 组件与服务端 lib 均可安全 import。
import type { TaskPriority, TaskStatus } from "@/db/schema";

export type { TaskPriority, TaskStatus };

export const TASK_STATUSES = ["todo", "doing", "done"] as const satisfies readonly TaskStatus[];
export const TASK_PRIORITIES = ["low", "medium", "high"] as const satisfies readonly TaskPriority[];

// 中文文案（动态流 diff、下拉选项、提示语用）。键序即展示序：todo→doing→done、low→medium→high
export const STATUS_TEXT: Record<string, string> = { todo: "待办", doing: "进行中", done: "已完成" };
export const PRIORITY_TEXT: Record<string, string> = { low: "低", medium: "中", high: "高" };

// 徽章配色（ac-badge 配套的软色 token）。与子任务列表/详情页头部惯例一致（状态用 /10 软色）。
// task-database 与 attachment-center 的 todo 是中性灰（bg-sunken text-ink-soft）的另一套旧惯例，
// 本模块收敛采用前者；那两处暂留本地旧值以保证 UI 不动，待表格视图重写（PR2）时统一。
export const STATUS_BADGE: Record<string, string> = {
  todo: "bg-todo/10 text-todo",
  doing: "bg-doing/10 text-doing",
  done: "bg-done/10 text-done",
};
export const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-high-soft text-high",
  medium: "bg-medium-soft text-medium",
  low: "bg-low-soft text-low",
};

// 筛选条/下拉的选项（{id, name} 形状同 FilterBar 的 Option）；优先级按高→中→低展示
export const PRIORITY_OPTIONS: { id: TaskPriority; name: string }[] = [...TASK_PRIORITIES]
  .reverse()
  .map((p) => ({ id: p, name: PRIORITY_TEXT[p] }));
