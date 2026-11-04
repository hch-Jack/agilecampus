import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { approvalRequests, teamMembers, tasks } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, updateTask } from "@/lib/task";
import { decideApproval, isApproverAnywhere } from "@/lib/approval";
import {
  effectivePermissions,
  hasPermission,
  listMembersWithPermissions,
  setMemberPermission,
} from "@/lib/team-permissions";
import { AppError, ApprovalRequestedError, ForbiddenError } from "@/lib/errors";
import { resetDb } from "./helpers";

async function makeUser(email: string, identity?: "teacher" | "student") {
  return createUser({
    email,
    password: "password123",
    name: email.split("@")[0],
    identity: identity ?? null,
  });
}

async function scene() {
  const admin = await makeUser("admin@example.com");
  const team = await createTeam(admin.id, "测试团");
  const teacher = await makeUser("teacher@example.com", "teacher");
  await joinTeam(teacher.id, team.inviteCode);
  const student = await makeUser("student@example.com", "student");
  await joinTeam(student.id, team.inviteCode);
  const project = await createProject(admin.id, team.id, { name: "项目甲" });
  const task = await createTask(admin.id, project.id, { title: "任务一", assigneeId: student.id });
  await updateTask(admin.id, task.id, { status: "doing" });
  return { admin, teacher, student, team, project, task };
}

const memberRow = async (teamId: string, userId: string) => {
  const [row] = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
  return row;
};

const pendingRow = async () => {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.status, "pending"));
  return row ?? null;
};

describe("团队权限模型", () => {
  beforeEach(resetDb);

  it("admin 天然拥有全部权限；角色不再是审批权来源——未勾选的 teacher 与 student 一样无权", async () => {
    const { admin, teacher, student, team } = await scene();
    const adminRow = await memberRow(team.id, admin.id);
    expect(effectivePermissions(adminRow.role, adminRow)).toEqual({
      taskDone: true,
      resource: true,
      project: true,
    });
    expect(await isApproverAnywhere(teacher.id)).toBe(false);
    expect(await isApproverAnywhere(student.id)).toBe(false);
    expect(await isApproverAnywhere(admin.id)).toBe(true);
  });

  it("勾选即生效：学生获得任务审核权后能批完成申请", async () => {
    const { admin, team, student, task } = await scene();
    const other = await makeUser("other@example.com", "student");
    await joinTeam(other.id, team.inviteCode);
    // 先无权：批不了
    await expect(updateTask(student.id, task.id, { status: "done" })).rejects.toBeInstanceOf(
      ApprovalRequestedError,
    );
    const pending = (await pendingRow())!;
    await expect(decideApproval(other.id, pending.id, "approved")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    // 授予后能批
    await setMemberPermission(admin.id, team.id, other.id, "task_done", true);
    await decideApproval(other.id, pending.id, "approved");
    const [after] = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, task.id));
    expect(after.status).toBe("done");
  });

  it("只有 admin 能勾选；admin 行不可改；非成员不可被授权", async () => {
    const { admin, teacher, student, team } = await scene();
    await expect(
      setMemberPermission(teacher.id, team.id, student.id, "resource", true),
    ).rejects.toBeInstanceOf(ForbiddenError);
    // admin 行：天然全有，改它没有意义
    await expect(
      setMemberPermission(admin.id, team.id, admin.id, "resource", false),
    ).rejects.toBeInstanceOf(AppError);
    const outsider = await makeUser("outsider@example.com");
    await expect(
      setMemberPermission(admin.id, team.id, outsider.id, "resource", true),
    ).rejects.toBeInstanceOf(AppError);
    expect(
      hasPermission("admin", { canApproveTaskDone: false, canApproveResource: false, canAcceptProject: false }, "project"),
    ).toBe(true);
  });

  it("listMembersWithPermissions：admin 折算为全有，勾选值如实返回", async () => {
    const { admin, teacher, team } = await scene();
    await setMemberPermission(admin.id, team.id, teacher.id, "resource", true);
    const members = await listMembersWithPermissions(team.id);
    const adminM = members.find((m) => m.userId === admin.id)!;
    const teacherM = members.find((m) => m.userId === teacher.id)!;
    expect(adminM.permissions).toEqual({ taskDone: true, resource: true, project: true });
    expect(teacherM.permissions).toEqual({ taskDone: false, resource: true, project: false });
  });
});
