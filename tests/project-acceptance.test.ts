import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { approvalRequests, projects, systemMessages, tasks } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, updateTask } from "@/lib/task";
import { setMemberPermission } from "@/lib/team-permissions";
import {
  completeProjectDirectly,
  decideApproval,
  getApprovalDetail,
  listPendingAcceptanceProjectIds,
  listPendingApprovalsForApprover,
  reopenProject,
  requestProjectAcceptance,
} from "@/lib/approval";
import { ForbiddenError } from "@/lib/errors";
import { resetDb } from "./helpers";

async function makeUser(email: string, identity?: "teacher" | "student") {
  return createUser({
    email,
    password: "password123",
    name: email.split("@")[0],
    identity: identity ?? null,
  });
}

// 布景：admin + teacher（被授予结题验收权）+ 学生；项目带一个学生名下进行中的任务
async function scene() {
  const admin = await makeUser("admin@example.com");
  const team = await createTeam(admin.id, "验收测试团");
  const teacher = await makeUser("teacher@example.com", "teacher");
  await joinTeam(teacher.id, team.inviteCode);
  await setMemberPermission(admin.id, team.id, teacher.id, "project", true);
  const student = await makeUser("student@example.com", "student");
  await joinTeam(student.id, team.inviteCode);

  const project = await createProject(admin.id, team.id, { name: "毕业设计" });
  const task = await createTask(admin.id, project.id, { title: "论文撰写", assigneeId: student.id });
  await updateTask(admin.id, task.id, { status: "doing" });
  return { admin, teacher, student, team, project, task };
}

const projectRow = async (projectId: string) => {
  const [row] = await db.select().from(projects).where(eq(projects.id, projectId));
  return row;
};

const acceptanceRow = async (projectId: string) => {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(
      // 只有一条能 pending（唯一索引兜底），直接按项目取即可
      eq(approvalRequests.projectId, projectId),
    );
  return row ?? null;
};

const taskStatus = async (taskId: string) => {
  const [row] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return row.status;
};

describe("项目结题验收：申请", () => {
  beforeEach(resetDb);

  it("任务未完成不予受理；全部完成后申请落库并提醒有权者", async () => {
    const { admin, teacher, student, project, task } = await scene();
    await expect(requestProjectAcceptance(student.id, project.id, "成果见附件")).rejects.toThrow(
      "还有 1 个任务未完成",
    );

    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id, "成果见附件");

    const row = await acceptanceRow(project.id);
    expect(row?.type).toBe("project_acceptance");
    expect(row?.status).toBe("pending");
    expect(row?.purpose).toBe("成果见附件");
    // 提醒送达有权者（teacher 被勾选 + admin 天然有），申请人自己没有
    const notices = await db
      .select({ userId: systemMessages.userId })
      .from(systemMessages);
    expect(notices.map((n) => n.userId).sort()).toEqual([admin.id, teacher.id].sort());

    // 已结题/归档的项目不可再申请
    const other = await createProject(admin.id, (await projectRow(project.id)).teamId, { name: "乙" });
    await db.update(projects).set({ status: "archived" }).where(eq(projects.id, other.id));
    await expect(requestProjectAcceptance(student.id, other.id)).rejects.toThrow("不在进行中");
  });

  it("同一项目同时只有一条 pending；非团队成员不能申请", async () => {
    const { admin, student, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id);
    await expect(requestProjectAcceptance(student.id, project.id)).rejects.toThrow("已有待审批");

    const outsider = await makeUser("outsider@example.com");
    await expect(requestProjectAcceptance(outsider.id, project.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("项目结题验收：决定", () => {
  beforeEach(resetDb);

  it("无验收权者不能决定；通过后项目 completed、申请人收回执", async () => {
    const { admin, teacher, student, team, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id, "全部完成");
    const row = (await acceptanceRow(project.id))!;

    // 无权的学生/未被勾选的老师路径：另建一个没权限的 teacher
    const teacherNoPerm = await makeUser("noperm@example.com", "teacher");
    await joinTeam(teacherNoPerm.id, team.inviteCode);
    await expect(decideApproval(teacherNoPerm.id, row.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await decideApproval(teacher.id, row.id, "approved");
    expect((await projectRow(project.id)).status).toBe("completed");
    const [receipt] = await db
      .select({ content: systemMessages.content })
      .from(systemMessages)
      .where(eq(systemMessages.userId, student.id));
    expect(receipt.content).toContain("结题验收");
    expect(receipt.content).toContain("审批通过");
  });

  it("拒绝：项目保持 active、任务保持原状，可重新申请", async () => {
    const { admin, student, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id);
    const row = (await acceptanceRow(project.id))!;
    await decideApproval(admin.id, row.id, "rejected", "材料不全");
    expect((await projectRow(project.id)).status).toBe("active");
    expect(await taskStatus(task.id)).toBe("done");

    await requestProjectAcceptance(student.id, project.id);
    expect(await acceptanceRow(project.id)).not.toBeNull();
  });

  it("申请未决期间任务被挪回未完成：通过时拦截，决定回滚", async () => {
    const { admin, teacher, student, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id);
    const row = (await acceptanceRow(project.id))!;
    await updateTask(admin.id, task.id, { status: "doing" }); // 漂移

    await expect(decideApproval(teacher.id, row.id, "approved")).rejects.toThrow(
      "还有 1 个任务未完成",
    );
    // 决定连同业务写入一并回滚：申请仍在 pending，项目仍 active
    expect((await acceptanceRow(project.id))?.status).toBe("pending");
    expect((await projectRow(project.id)).status).toBe("active");
  });

  it("不能审批自己发起的申请", async () => {
    const { admin, team, student, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    // 给学生也勾上验收权：有权限，但申请是自己发的
    await setMemberPermission(admin.id, team.id, student.id, "project", true);
    await requestProjectAcceptance(student.id, project.id);
    const row = (await acceptanceRow(project.id))!;
    await expect(decideApproval(student.id, row.id, "approved")).rejects.toThrow(
      "不能审批自己发起的申请",
    );
  });

  it("审批人视角：pending 列表带项目名，详情按类型验权", async () => {
    const { admin, teacher, student, team, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id);

    const forTeacher = await listPendingApprovalsForApprover(teacher.id);
    expect(forTeacher).toHaveLength(1);
    expect(forTeacher[0].type).toBe("project_acceptance");
    expect(forTeacher[0].projectName).toBe("毕业设计");

    expect((await listPendingAcceptanceProjectIds([project.id])).has(project.id)).toBe(true);

    const detail = await getApprovalDetail(teacher.id, forTeacher[0].id);
    expect(detail.projectName).toBe("毕业设计");
    expect(detail.purpose).toBeNull();
    // 无关成员（另一个学生）看不了详情
    const stranger = await makeUser("stranger@example.com", "student");
    await joinTeam(stranger.id, team.inviteCode);
    await expect(getApprovalDetail(stranger.id, forTeacher[0].id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe("项目结题验收：直接结题", () => {
  beforeEach(resetDb);

  it("有权者直接结题：项目 completed，未决申请作废；无权者/未完任务被拒", async () => {
    const { admin, teacher, student, project, task } = await scene();

    // 任务未完成：即使有权也不能结题
    await expect(completeProjectDirectly(teacher.id, project.id)).rejects.toThrow(
      "还有 1 个任务未完成",
    );

    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id);
    expect(await acceptanceRow(project.id)).not.toBeNull();

    // 无权学生被拒
    await expect(completeProjectDirectly(student.id, project.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // 有权 teacher（勾选）直接结题：未决申请被替代
    await completeProjectDirectly(teacher.id, project.id);
    expect((await projectRow(project.id)).status).toBe("completed");
    expect(await acceptanceRow(project.id)).toBeNull();

    // 已结题的再来一次：状态不对
    await expect(completeProjectDirectly(admin.id, project.id)).rejects.toThrow("不在进行中");
  });
});

describe("项目结题验收：恢复进行中", () => {
  beforeEach(resetDb);

  it("有权者恢复：项目回 active，任务保持已完成；无权者被拒", async () => {
    const { admin, teacher, student, project, task } = await scene();
    await updateTask(admin.id, task.id, { status: "done" });
    await requestProjectAcceptance(student.id, project.id);
    const row = (await acceptanceRow(project.id))!;
    await decideApproval(teacher.id, row.id, "approved");
    expect((await projectRow(project.id)).status).toBe("completed");

    // 无权学生不能恢复
    await expect(reopenProject(student.id, project.id)).rejects.toBeInstanceOf(ForbiddenError);
    // 有权 teacher 恢复：项目回到进行中，任务保持已完成
    await reopenProject(teacher.id, project.id);
    expect((await projectRow(project.id)).status).toBe("active");
    expect(await taskStatus(task.id)).toBe("done");

    // 非已结题状态再恢复：报错
    await expect(reopenProject(admin.id, project.id)).rejects.toThrow("不在已结题");
  });
});
