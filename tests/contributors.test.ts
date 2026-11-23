import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, updateTask } from "@/lib/task";
import { listProjectContributors } from "@/lib/contributors";
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

// 布景：admin 建团建项目；studentA 干活（完成 2、在办 1，其一子任务）；studentB 只在办 1；studentC 旁观
async function scene() {
  const admin = await makeUser("admin@example.com", "teacher");
  const team = await createTeam(admin.id, "贡献度测试团");
  const a = await makeUser("a@example.com", "student");
  await joinTeam(a.id, team.inviteCode);
  const b = await makeUser("b@example.com", "student");
  await joinTeam(b.id, team.inviteCode);
  const c = await makeUser("c@example.com", "student");
  await joinTeam(c.id, team.inviteCode);

  const project = await createProject(admin.id, team.id, { name: "毕业设计" });
  return { admin, team, a, b, c, project };
}

const rowOf = (rows: Awaited<ReturnType<typeof listProjectContributors>>["rows"], userId: string) =>
  rows.find((r) => r.userId === userId)!;

describe("listProjectContributors", () => {
  beforeEach(resetDb);

  it("完成/在办/创建/动态分账户统计；子任务完成计入负责人；未参与者不出行", async () => {
    const { admin, a, b, c, project } = await scene();

    // admin 创建 3 个任务（创建计 admin 头上）
    const t1 = await createTask(admin.id, project.id, { title: "调研", assigneeId: a.id , requireApproval: false });
    const t2 = await createTask(admin.id, project.id, { title: "开发", assigneeId: a.id , requireApproval: false });
    const t3 = await createTask(admin.id, project.id, { title: "测试", assigneeId: b.id , requireApproval: false });
    const child = await createTask(admin.id, project.id, {
      title: "开发-前端", parentTaskId: t2.id, assigneeId: a.id, requireApproval: false,
    });
    // 负责人自己完成（完成动态的 actor = 本人）
    await updateTask(a.id, child.id, { status: "done" });
    await updateTask(a.id, t1.id, { status: "done" });
    void t3;

    const { rows } = await listProjectContributors(admin.id, project.id);
    const adminRow = rowOf(rows, admin.id);
    const aRow = rowOf(rows, a.id);
    const bRow = rowOf(rows, b.id);

    // admin：创建了 3 个（子任务也算 created 动态，共 4），0 完成 0 在办
    expect(adminRow.created).toBe(4);
    expect(adminRow.done).toBe(0);
    expect(adminRow.active).toBe(0);
    // a：完成 2（t1 + 子任务，子任务归属负责人 a）、在办 1（t2）
    expect(aRow.done).toBe(2);
    expect(aRow.active).toBe(1);
    expect(aRow.completionRate).toBeCloseTo(2 / 3, 6);
    // b：在办 1
    expect(bRow.active).toBe(1);
    expect(bRow.done).toBe(0);
    // c 旁观：完全没参与，不出行
    expect(rows.find((r) => r.userId === c.id)).toBeUndefined();
    // 排序：完成多的在前
    expect(rows[0].userId).toBe(a.id);
  });

  it("按时完成率：有截止日且可判定完成时点的任务才计入；转交后完成仍归原完成者", async () => {
    const { admin, a, b, project } = await scene();
    const t1 = await createTask(admin.id, project.id, {
      title: "限期任务", assigneeId: a.id, dueDate: "2099-12-31", requireApproval: false,
    });
    await updateTask(a.id, t1.id, { status: "done" }); // 远期截止 → 按时

    const t2 = await createTask(admin.id, project.id, {
      title: "过期任务", assigneeId: a.id, dueDate: "2020-01-01", requireApproval: false,
    });
    await updateTask(a.id, t2.id, { status: "done" }); // 已过期 → 不按时

    const t3 = await createTask(admin.id, project.id, { title: "无截止", assigneeId: b.id , requireApproval: false });
    await updateTask(b.id, t3.id, { status: "done" }); // 无截止日 → 不计入

    const { rows } = await listProjectContributors(admin.id, project.id);
    const aRow = rowOf(rows, a.id);
    expect(aRow.done).toBe(2);
    expect(aRow.onTimeRate).toBeCloseTo(0.5, 6); // 2 个有判定的里中了 1
    const bRow = rowOf(rows, b.id);
    expect(bRow.done).toBe(1);
    expect(bRow.onTimeRate).toBeNull(); // 没有可判定的任务
  });

  it("任务转交：历史完成归完成动态的 actor，在办归新负责人", async () => {
    const { admin, a, b, project } = await scene();
    const t = await createTask(admin.id, project.id, { title: "交接任务", assigneeId: a.id , requireApproval: false });
    await updateTask(a.id, t.id, { status: "done" }); // a 完成
    // 完成后改负责人到 b：完成数不挪窝
    await db.update(tasks).set({ assigneeId: b.id }).where(eq(tasks.id, t.id));
    // b 再领一个新任务在办
    await createTask(admin.id, project.id, { title: "新任务", assigneeId: b.id , requireApproval: false });

    const { rows } = await listProjectContributors(admin.id, project.id);
    expect(rowOf(rows, a.id).done).toBe(1); // 完成仍归 a
    const bRow = rowOf(rows, b.id);
    expect(bRow.done).toBe(0);
    expect(bRow.active).toBe(1); // 在办归新负责人
  });

  it("无访问权者被拒；项目名带回", async () => {
    const { admin, project } = await scene();
    const { projectName } = await listProjectContributors(admin.id, project.id);
    expect(projectName).toBe("毕业设计");
    const outsider = await makeUser("outsider@example.com");
    await expect(listProjectContributors(outsider.id, project.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});
