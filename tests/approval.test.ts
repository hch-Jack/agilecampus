import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  approvalRequests,
  systemMessages,
  resourceUsages,
  taskActivities,
  tasks,
} from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, createSubtask, updateTask } from "@/lib/task";
import { createResourceUsage } from "@/lib/resource";
import {
  countUnreadSystemMessages,
  decideApproval,
  getApprovalDetail,
  getApprovalStatus,
  isApproverAnywhere,
  listMyApprovalHistory,
  listMyResourceRequests,
  listMySystemMessages,
  listPendingApprovalsForApprover,
  listPendingTaskDoneTaskIds,
  markSystemMessagesRead,
  requestResourceUsage,
} from "@/lib/approval";
import { DECISION_NOTE_MAX_LENGTH } from "@/lib/approval-view";
import { ApprovalRequestedError, AppError, ForbiddenError } from "@/lib/errors";
import { resetDb } from "./helpers";

async function makeUser(email: string, identity?: "teacher" | "student") {
  return createUser({
    email,
    password: "password123",
    name: email.split("@")[0],
    identity: identity ?? null,
  });
}

// 常用布景：admin 建团，teacher（教师身份加入即 teacher 角色）与学生各就位，项目与任务就绪。
// 任务默认拖到「进行中」——完成审批只发生在 doing→done 这一步。
async function scene() {
  const admin = await makeUser("admin@example.com");
  const team = await createTeam(admin.id, "东吴实验室");
  const teacher = await makeUser("teacher@example.com", "teacher");
  await joinTeam(teacher.id, team.inviteCode);
  const student = await makeUser("student@example.com", "student");
  await joinTeam(student.id, team.inviteCode);

  const project = await createProject(admin.id, team.id, { name: "毕业设计" });
  const task = await createTask(admin.id, project.id, {
    title: "数据采集",
    assigneeId: student.id,
  });
  await updateTask(admin.id, task.id, { status: "doing" });

  const pendingRow = async () => {
    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.taskId, task.id), eq(approvalRequests.status, "pending")));
    return row ?? null;
  };
  return { admin, teacher, student, team, project, task, pendingRow };
}

describe("任务完成审批：申请与撤回", () => {
  beforeEach(resetDb);

  it("学生 doing→done 被拦截：任务保持进行中，产生 pending 申请，老师与管理员各收到提醒私信", async () => {
    const { student, teacher, admin, task, pendingRow } = await scene();

    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.status).toBe("doing");

    const pending = await pendingRow();
    expect(pending).not.toBeNull();
    expect(pending!.requesterId).toBe(student.id);
    expect(pending!.type).toBe("task_done");

    // 提醒走系统消息（不再建点对点私信）：老师与管理员各一条，学生自己没有
    const msgs = await db
      .select({ userId: systemMessages.userId, content: systemMessages.content })
      .from(systemMessages);
    const recipients = msgs.map((m) => m.userId).sort();
    expect(recipients).toEqual([admin.id, teacher.id].sort());
    expect(msgs[0].content).toContain("完成审批");
    expect(await countUnreadSystemMessages(teacher.id)).toBe(1);
    expect(await listMySystemMessages(student.id)).toHaveLength(0);
  });

  it("同一任务同时只允许一条 pending 申请", async () => {
    const { student, task } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("学生从待办直跳完成同样被拦截（堵住绕过审批的口子）", async () => {
    const { student, task, pendingRow } = await scene();
    // scene 里任务已被挪到进行中；拖回待办后再直跳完成
    await updateTask(student.id, task.id, { status: "todo" });
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;
    expect(pending).not.toBeNull();
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.status).toBe("todo");
  });

  it("任务拖回待办 = 撤回申请，pending 行删除", async () => {
    const { student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    await updateTask(student.id, task.id, { status: "todo" });
    expect(await pendingRow()).toBeNull();
  });

  it("管理员直接完成任务：申请被撤掉，不经过审批", async () => {
    const { admin, student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const updated = await updateTask(admin.id, task.id, { status: "done" });
    expect(updated.status).toBe("done");
    expect(await pendingRow()).toBeNull();
  });

  it("子任务完成不拦截（审批只看父任务）", async () => {
    const { admin, student, task } = await scene();
    const sub = await createSubtask(admin.id, task.id, {
      title: "写脚本",
      assigneeId: student.id,
    });
    await updateTask(student.id, sub.id, { status: "doing" });
    const done = await updateTask(student.id, sub.id, { status: "done" });
    expect(done.status).toBe("done");
    const pendings = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.type, "task_done"));
    expect(pendings).toHaveLength(0);
  });

  it("任务完成伴随的其他字段照常落库并记入动态（只拦状态）", async () => {
    const { student, task } = await scene();
    await expect(
      updateTask(student.id, task.id, { status: "done", completionNote: "采完 500 条" }),
    ).rejects.toBeInstanceOf(ApprovalRequestedError);
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.status).toBe("doing");
    expect(after.completionNote).toBe("采完 500 条");
    const acts = await db
      .select({ type: taskActivities.type, field: taskActivities.field, newValue: taskActivities.newValue })
      .from(taskActivities)
      .where(eq(taskActivities.taskId, task.id));
    // 有「提交完成审批」与「完成情况」变更，没有把状态改成「已完成」的记录
    // （setup 拖到进行中本身会有一条 待办→进行中 的状态动态，不看它）
    expect(acts.some((a) => a.type === "approval_requested")).toBe(true);
    expect(acts.some((a) => a.type === "field" && a.field === "完成情况")).toBe(true);
    expect(acts.some((a) => a.type === "field" && a.field === "状态" && a.newValue === "已完成")).toBe(false);
  });

  it("申请完成不级联子任务：拒绝后子任务保持提交前原状，通过才一并完成", async () => {
    const { admin, teacher, student, task, pendingRow } = await scene();
    const subDone = await createSubtask(admin.id, task.id, { title: "已完成子任务", assigneeId: student.id });
    const subDoing = await createSubtask(admin.id, task.id, { title: "进行中子任务", assigneeId: student.id });
    await updateTask(student.id, subDone.id, { status: "done" });
    await updateTask(student.id, subDoing.id, { status: "doing" });

    const statusOf = async (id: string) => {
      const [row] = await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, id));
      return row?.s;
    };

    // 学生提交完成申请：父任务与子任务都不动，不提前级联
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    expect(await statusOf(task.id)).toBe("doing");
    expect(await statusOf(subDone.id)).toBe("done");
    expect(await statusOf(subDoing.id)).toBe("doing");

    // 拒绝：子任务维持提交前的版本（不被拉成已完成）
    const pending = (await pendingRow())!;
    await decideApproval(admin.id, pending.id, "rejected");
    expect(await statusOf(task.id)).toBe("doing");
    expect(await statusOf(subDone.id)).toBe("done");
    expect(await statusOf(subDoing.id)).toBe("doing");

    // 重新申请并通过：此刻才级联，未完成的子任务一并落「已完成」
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    await decideApproval(teacher.id, (await pendingRow())!.id, "approved");
    expect(await statusOf(task.id)).toBe("done");
    expect(await statusOf(subDone.id)).toBe("done");
    expect(await statusOf(subDoing.id)).toBe("done");
  });

  it("从待审核列拖回原状态列（显式改同状态）也撤回未决申请", async () => {
    const { student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    expect(await pendingRow()).not.toBeNull();

    // 任务本就是 doing：把卡从「待审核」拖回「进行中」status 新旧值相同，也应撤回
    await updateTask(student.id, task.id, { status: "doing" });
    expect(await pendingRow()).toBeNull();
  });
});

describe("任务完成审批：决定", () => {
  beforeEach(resetDb);

  it("老师通过：任务标成已完成，学生收到通过私信，第二条决定报已被处理", async () => {
    const { admin, student, teacher, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;

    await decideApproval(teacher.id, pending.id, "approved");

    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.status).toBe("done");
    expect(await getApprovalStatus(pending.id)).toBe("approved");

    // 回执走系统消息；学生与审批人都能打开详情
    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).toContain("审批通过");
    const detailForStudent = await getApprovalDetail(student.id, pending.id);
    expect(detailForStudent.taskTitle).toBe("数据采集");
    const detailForTeacher = await getApprovalDetail(teacher.id, pending.id);
    expect(detailForTeacher.requesterName).toBe("student");

    // 动态里有补记的状态变更（审批人操作）
    const acts = await db
      .select({ field: taskActivities.field, newValue: taskActivities.newValue })
      .from(taskActivities)
      .where(and(eq(taskActivities.taskId, task.id), eq(taskActivities.type, "field")));
    expect(acts.some((a) => a.field === "状态" && a.newValue === "已完成")).toBe(true);

    await expect(decideApproval(admin.id, pending.id, "approved")).rejects.toThrow("该审批已被处理");
  });

  it("审批通过走统一完成入口：父任务的完成级联对子任务生效", async () => {
    const { admin, student, teacher, task, pendingRow } = await scene();
    const sub = await createSubtask(admin.id, task.id, { title: "子任务", assigneeId: student.id });
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;

    // 审批人是 teacher（只读角色）也能通过：approvedBy 豁免写角色检查
    await decideApproval(teacher.id, pending.id, "approved");

    const [parent] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(parent.status).toBe("done");
    const [child] = await db.select().from(tasks).where(eq(tasks.id, sub.id));
    expect(child.status).toBe("done");
  });

  it("拒绝：任务保持进行中，学生收到被拒私信，可重新提交", async () => {
    const { admin, student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;

    await decideApproval(admin.id, pending.id, "rejected");
    expect(await getApprovalStatus(pending.id)).toBe("rejected");
    const [after] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(after.status).toBe("doing");

    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).toContain("审批被拒");

    // 拒绝后可重新申请
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    expect(await pendingRow()).not.toBeNull();
  });

  it("权限：学生/外部人员/其他角色都不能决定", async () => {
    const { student, team, task, pendingRow } = await scene();
    const otherStudent = await makeUser("other-student@example.com", "student");
    await joinTeam(otherStudent.id, team.inviteCode);
    const outsider = await makeUser("outsider@example.com");

    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;

    await expect(decideApproval(student.id, pending.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decideApproval(otherStudent.id, pending.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(decideApproval(outsider.id, pending.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await getApprovalStatus(pending.id)).toBe("pending");
  });

  it("决定时任务已非进行中：通过报「状态已变化」", async () => {
    const { student, teacher, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;

    // 正常路径下状态变化会先撤回申请（见上）；
    // 这里绕过 lib 直改库，模拟「审批人打开卡片后任务状态才变化」的竞态兜底
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    await expect(decideApproval(teacher.id, pending.id, "approved")).rejects.toThrow(
      "任务状态已变化",
    );
    // 决定回滚：申请仍为 pending，任务保持被直改后的状态
    expect(await getApprovalStatus(pending.id)).toBe("pending");
  });
});

describe("资源占用审批", () => {
  beforeEach(resetDb);

  it("学生申请：pending 落库且不建占用行；老师通过后按快照建行（占用人=学生）", async () => {
    const { student, teacher, team } = await scene();
    const start = new Date("2026-11-01T09:00:00Z");
    const end = new Date("2026-11-01T12:00:00Z");
    await requestResourceUsage(student.id, team.id, {
      resourceName: "GPU-01",
      purpose: "训练模型",
      startTime: start,
      endTime: end,
    });

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requesterId, student.id));
    expect(pending.type).toBe("resource_usage");
    expect(pending.status).toBe("pending");
    expect(pending.resourceName).toBe("GPU-01");

    const before = await db.select().from(resourceUsages);
    expect(before).toHaveLength(0);

    await decideApproval(teacher.id, pending.id, "approved");
    const usages = await db.select().from(resourceUsages);
    expect(usages).toHaveLength(1);
    expect(usages[0].userId).toBe(student.id);
    expect(usages[0].resourceName).toBe("GPU-01");

    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).toContain("审批通过");

    // 资源申请的详情：申请人自己可回看快照
    const detail = await getApprovalDetail(student.id, pending.id);
    expect(detail.type).toBe("resource_usage");
    expect(detail.resourceName).toBe("GPU-01");
  });

  it("拒绝：不建占用行，学生收到被拒回执", async () => {
    const { admin, student, team } = await scene();
    await requestResourceUsage(student.id, team.id, {
      resourceName: "示波器",
      startTime: new Date("2026-11-02T09:00:00Z"),
    });
    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requesterId, student.id));

    await decideApproval(admin.id, pending.id, "rejected");
    expect(await db.select().from(resourceUsages)).toHaveLength(0);
    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).toContain("审批被拒");
  });

  it("老师/管理员登记占用直接生效，不经审批", async () => {
    const { admin, teacher, team } = await scene();
    await createResourceUsage(teacher.id, team.id, {
      resourceName: "服务器A",
      startTime: new Date("2026-11-03T09:00:00Z"),
    });
    await createResourceUsage(admin.id, team.id, {
      resourceName: "服务器B",
      startTime: new Date("2026-11-03T10:00:00Z"),
    });
    const usages = await db.select().from(resourceUsages);
    expect(usages).toHaveLength(2);
    const pendings = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.type, "resource_usage"));
    expect(pendings).toHaveLength(0);
  });
});

describe("审批查询辅助", () => {
  beforeEach(resetDb);

  it("listPendingApprovalsForApprover：老师与管理员能看到 pending，学生看不到", async () => {
    const { admin, student, teacher, task } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );

    const forTeacher = await listPendingApprovalsForApprover(teacher.id);
    const forAdmin = await listPendingApprovalsForApprover(admin.id);
    const forStudent = await listPendingApprovalsForApprover(student.id);
    expect(forTeacher).toHaveLength(1);
    expect(forTeacher[0].taskTitle).toBe("数据采集");
    expect(forTeacher[0].requesterName).toBe("student");
    expect(forAdmin).toHaveLength(1);
    expect(forStudent).toHaveLength(0);
  });

  it("listPendingTaskDoneTaskIds 与 isApproverAnywhere", async () => {
    const { student, admin, teacher, task } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const ids = await listPendingTaskDoneTaskIds([task.id]);
    expect(ids.has(task.id)).toBe(true);

    expect(await isApproverAnywhere(teacher.id)).toBe(true);
    expect(await isApproverAnywhere(admin.id)).toBe(true);
    expect(await isApproverAnywhere(student.id)).toBe(false);
  });
});

describe("系统消息查询", () => {
  beforeEach(resetDb);

  it("审批人看到申请提醒（canDecide=true），申请人只在有结果后收到回执", async () => {
    const { student, teacher, task } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );

    const forTeacher = await listMySystemMessages(teacher.id);
    expect(forTeacher).toHaveLength(1);
    expect(forTeacher[0].canDecide).toBe(true);
    expect(forTeacher[0].approvalStatus).toBe("pending");
    expect(forTeacher[0].approvalType).toBe("task_done");
    expect(forTeacher[0].taskTitle).toBe("数据采集");
    expect(forTeacher[0].requesterName).toBe("student");
    // 未决前学生什么都没有（不看别人的申请）
    expect(await listMySystemMessages(student.id)).toHaveLength(0);

    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requesterId, student.id));
    await decideApproval(teacher.id, pending.id, "approved");

    const forStudent = await listMySystemMessages(student.id);
    expect(forStudent).toHaveLength(1);
    expect(forStudent[0].content).toContain("审批通过");
    expect(forStudent[0].canDecide).toBe(false);
    expect(forStudent[0].approvalStatus).toBe("approved");
    // 审批人的原提醒还在，但状态已随之（未决才可批）
    const teacherAfter = await listMySystemMessages(teacher.id);
    expect(teacherAfter[0].canDecide).toBe(false);
  });

  it("展开系统消息栏即置读（markSystemMessagesRead）", async () => {
    const { student, teacher, task } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    expect(await countUnreadSystemMessages(teacher.id)).toBe(1);

    await markSystemMessagesRead(teacher.id);
    expect(await countUnreadSystemMessages(teacher.id)).toBe(0);
    const rows = await listMySystemMessages(teacher.id);
    expect(rows[0].readAt).not.toBeNull();
    // 学生的未读不受影响
    expect(await countUnreadSystemMessages(student.id)).toBe(0);
  });

  it("listMyResourceRequests：我的资源申请带审批人与决定时刻", async () => {
    const { student, teacher, team } = await scene();
    await requestResourceUsage(student.id, team.id, {
      resourceName: "服务器A",
      purpose: "部署服务",
      startTime: new Date("2026-11-05T09:00:00Z"),
      endTime: new Date("2026-11-05T18:00:00Z"),
    });
    const [pending] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.requesterId, student.id));

    let rows = await listMyResourceRequests(student.id, team.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");

    await decideApproval(teacher.id, pending.id, "approved");
    rows = await listMyResourceRequests(student.id, team.id);
    expect(rows[0].status).toBe("approved");
    expect(rows[0].approverName).toBe("teacher");
    expect(rows[0].decidedAt).not.toBeNull();
  });
});

describe("任务完成审批开关（requireApproval）", () => {
  beforeEach(resetDb);

  it("新建任务默认需要审批", async () => {
    const { task } = await scene();
    expect(task.requireApproval).toBe(true);
  });

  it("关掉审批的任务：学生拖到已完成直接完成，不生成申请", async () => {
    const { admin, student, project } = await scene();
    const free = await createTask(admin.id, project.id, {
      title: "自由任务",
      assigneeId: student.id,
      requireApproval: false,
    });
    await updateTask(admin.id, free.id, { status: "doing" });

    const done = await updateTask(student.id, free.id, { status: "done" });
    expect(done.status).toBe("done");

    const pendings = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.taskId, free.id));
    expect(pendings).toHaveLength(0);
    expect(await listMySystemMessages(student.id)).toHaveLength(0);
  });
});

describe("拒绝原因：随回执送达申请人", () => {
  beforeEach(resetDb);

  it("拒绝时填写原因：系统消息带上原因，详情与学生侧记录都能看到", async () => {
    const { admin, student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;

    await decideApproval(admin.id, pending.id, "rejected", "  资料不全，请补充截图  ");

    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).toContain("拒绝原因：资料不全，请补充截图");

    const detail = await getApprovalDetail(student.id, pending.id);
    expect(detail.decisionNote).toBe("资料不全，请补充截图");
    const studentMsgs = await listMySystemMessages(student.id);
    expect(studentMsgs[0].decisionNote).toBe("资料不全，请补充截图");

    // 申请人可在审批历史里回看这条回复
    const history = await listMyApprovalHistory(student.id);
    expect(history[0].decisionNote).toBe("资料不全，请补充截图");
  });

  it("拒绝原因为空时沿用通用文案；通过时原因不落库", async () => {
    const { admin, student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;
    await decideApproval(admin.id, pending.id, "rejected", "   ");
    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).not.toContain("拒绝原因");

    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const again = (await pendingRow())!;
    await decideApproval(admin.id, again.id, "approved", "通过时写的原因会被忽略");
    expect((await getApprovalDetail(admin.id, again.id)).decisionNote).toBeNull();
  });

  it("原因超长会被截断到上限", async () => {
    const { admin, student, task, pendingRow } = await scene();
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;
    await decideApproval(admin.id, pending.id, "rejected", "长".repeat(DECISION_NOTE_MAX_LENGTH + 50));
    const detail = await getApprovalDetail(admin.id, pending.id);
    expect(detail.decisionNote).toHaveLength(DECISION_NOTE_MAX_LENGTH);
  });
});

describe("审批历史（看板右上角弹窗的数据源）", () => {
  beforeEach(resetDb);

  it("我发起的与我审批的分开标记，团队外的人看不到", async () => {
    const { admin, teacher, student, team, task, pendingRow } = await scene();
    await requestResourceUsage(student.id, team.id, {
      resourceName: "GPU-01",
      startTime: new Date("2026-11-01T09:00:00Z"),
    });
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;
    await decideApproval(teacher.id, pending.id, "approved");

    const forStudent = await listMyApprovalHistory(student.id);
    expect(forStudent).toHaveLength(2);
    expect(forStudent.every((r) => r.direction === "requested")).toBe(true);
    expect(forStudent.every((r) => r.teamId === team.id)).toBe(true);
    const taskRow = forStudent.find((r) => r.type === "task_done")!;
    expect(taskRow.taskTitle).toBe("数据采集");
    expect(taskRow.status).toBe("approved");
    expect(taskRow.approverName).toBe("teacher");

    const forTeacher = await listMyApprovalHistory(teacher.id);
    expect(forTeacher).toHaveLength(1);
    expect(forTeacher[0].direction).toBe("decided");
    expect(forTeacher[0].requesterName).toBe("student");

    const outsider = await makeUser("outsider2@example.com");
    expect(await listMyApprovalHistory(outsider.id)).toHaveLength(0);
    expect(await listMyApprovalHistory(admin.id)).toHaveLength(0);
  });
});
