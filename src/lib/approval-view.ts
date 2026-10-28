/**
 * 审批相关的**纯展示函数**：给客户端组件用的最小模块。
 * 刻意与 lib/approval.ts（引了 db 的服务端逻辑）分开——客户端一旦从那边
 * import 任何东西，postgres 驱动就会被打进浏览器包。
 */

/** 拒绝原因的长度上限：对话框 maxLength、server action 校验与落库截断共用 */
export const DECISION_NOTE_MAX_LENGTH = 200;

export type ApprovalTypeLike = "task_done" | "resource_usage" | "project_acceptance";

/** 申请类型的展示名（工作台卡片角标、消息页等共用） */
export const APPROVAL_TYPE_LABEL: Record<ApprovalTypeLike, string> = {
  task_done: "任务完成",
  resource_usage: "资源占用",
  project_acceptance: "结题验收",
};

/** 申请单的主题（对象名）：任务名 / 资源名 / 项目名 */
export function approvalSubject(row: {
  type: ApprovalTypeLike;
  taskTitle?: string | null;
  resourceName?: string | null;
  projectName?: string | null;
}): string {
  if (row.type === "task_done") return row.taskTitle ?? "";
  if (row.type === "project_acceptance") return row.projectName ?? "";
  return row.resourceName ?? "";
}

export function approvalDetailHref(row: {
  type: ApprovalTypeLike;
  taskId: string | null;
  projectId: string | null;
  teamId: string;
}): string | null {
  if (row.type === "task_done" && row.taskId && row.projectId)
    return `/projects/${row.projectId}/tasks/${row.taskId}`;
  if (row.type === "resource_usage") return `/teams/${row.teamId}/resources`;
  // 结题验收：能点进项目页看全貌（状态徽章与结题入口都在那里）
  if (row.type === "project_acceptance" && row.projectId) return `/projects/${row.projectId}`;
  return null;
}
