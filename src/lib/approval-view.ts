/**
 * 审批相关的**纯展示函数**：给客户端组件用的最小模块。
 * 刻意与 lib/approval.ts（引了 db 的服务端逻辑）分开——客户端一旦从那边
 * import 任何东西，postgres 驱动就会被打进浏览器包。
 */

/** 拒绝原因的长度上限：对话框 maxLength、server action 校验与落库截断共用 */
export const DECISION_NOTE_MAX_LENGTH = 200;

export function approvalDetailHref(row: {
  type: "task_done" | "resource_usage";
  taskId: string | null;
  projectId: string | null;
  teamId: string;
}): string | null {
  if (row.type === "task_done" && row.taskId && row.projectId)
    return `/projects/${row.projectId}/tasks/${row.taskId}`;
  if (row.type === "resource_usage") return `/teams/${row.teamId}/resources`;
  return null;
}
