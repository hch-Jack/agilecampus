import { describe, expect, it } from "vitest";
import { workbenchColumnForTask } from "@/lib/workbench-board-columns";

describe("workbenchColumnForTask", () => {
  it("待审批优先于底层状态", () => {
    expect(workbenchColumnForTask({ status: "todo", approvalStatus: "pending" })).toBe("pending");
    expect(workbenchColumnForTask({ status: "doing", approvalStatus: "pending" })).toBe("pending");
  });

  it("已通过 / 已驳回仍留在底层状态列", () => {
    expect(workbenchColumnForTask({ status: "done", approvalStatus: "approved" })).toBe("done");
    expect(workbenchColumnForTask({ status: "doing", approvalStatus: "rejected" })).toBe("doing");
  });

  it("没有审批记录时按任务状态落列", () => {
    expect(workbenchColumnForTask({ status: "todo" })).toBe("todo");
    expect(workbenchColumnForTask({ status: "doing" })).toBe("doing");
    expect(workbenchColumnForTask({ status: "done" })).toBe("done");
  });
});
