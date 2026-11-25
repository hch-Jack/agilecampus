export type WorkbenchColumnKey = "todo" | "doing" | "pending" | "done";

type TaskLike = {
  status: "todo" | "doing" | "done";
  approvalStatus?: "pending" | "approved" | "rejected";
};

/**
 * 工作台看板的落列口径：有待审批申请的任务只进「待审批」列，
 * 不再同时出现在底层状态列（与项目看板 board-columns 的优先级一致）。
 */
export function workbenchColumnForTask(task: TaskLike): WorkbenchColumnKey {
  return task.approvalStatus === "pending" ? "pending" : task.status;
}
