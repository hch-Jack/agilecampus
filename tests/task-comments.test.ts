import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { tasks, users, teams, teamMembers, projects } from "@/db/schema";
import {
  listProjectComments,
  listTaskComments,
  createTaskComment,
  deleteTaskComment,
} from "@/lib/comment";
import { resetDb } from "./helpers";
import { ForbiddenError } from "@/lib/errors";

describe("Task Comments (留言板)", () => {
  beforeEach(resetDb);

  it("team members can list, create, and delete task comments", async () => {
    const [u1] = await db.insert(users).values({ email: "u1@test.com", passwordHash: "x", name: "Alice" }).returning();
    const [u2] = await db.insert(users).values({ email: "u2@test.com", passwordHash: "x", name: "Bob" }).returning();
    const [team] = await db.insert(teams).values({ name: "Lab", inviteCode: "123456" }).returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, userId: u1.id, role: "admin" },
      { teamId: team.id, userId: u2.id, role: "student" },
    ]);
    const [proj] = await db.insert(projects).values({ teamId: team.id, name: "Research Project" }).returning();
    const [task] = await db.insert(tasks).values({ projectId: proj.id, title: "Task 1" }).returning();

    // Initially empty
    const commentsBefore = await listTaskComments(u1.id, task.id);
    expect(commentsBefore).toHaveLength(0);

    // Create comment
    const comment = await createTaskComment(u1.id, task.id, "Hello team!");
    expect(comment.content).toBe("Hello team!");
    expect(comment.authorId).toBe(u1.id);

    // List comments
    const commentsAfter = await listTaskComments(u2.id, task.id);
    expect(commentsAfter).toHaveLength(1);
    expect(commentsAfter[0].content).toBe("Hello team!");
    expect(commentsAfter[0].authorName).toBe("Alice");

    // Non-author student cannot delete Alice's comment
    await expect(deleteTaskComment(u2.id, comment.id)).rejects.toThrow(ForbiddenError);

    // Author can delete their own comment
    await deleteTaskComment(u1.id, comment.id);
    expect(await listTaskComments(u1.id, task.id)).toHaveLength(0);
  });
});

// 项目级留言汇总：项目助手据此回答「留言板说了什么」，权限仍按项目成员收敛
describe("listProjectComments", () => {
  beforeEach(resetDb);

  async function scene() {
    const [u1] = await db.insert(users).values({ email: "u1@test.com", passwordHash: "x", name: "Alice" }).returning();
    const [u2] = await db.insert(users).values({ email: "u2@test.com", passwordHash: "x", name: "Bob" }).returning();
    const [outsider] = await db.insert(users).values({ email: "o@test.com", passwordHash: "x", name: "外人" }).returning();
    const [team] = await db.insert(teams).values({ name: "Lab", inviteCode: "123456" }).returning();
    const [otherTeam] = await db.insert(teams).values({ name: "别家", inviteCode: "654321" }).returning();
    await db.insert(teamMembers).values([
      { teamId: team.id, userId: u1.id, role: "admin" },
      { teamId: team.id, userId: u2.id, role: "student" },
      { teamId: otherTeam.id, userId: outsider.id, role: "admin" },
    ]);
    const [proj] = await db.insert(projects).values({ teamId: team.id, name: "Research Project" }).returning();
    const [otherProj] = await db.insert(projects).values({ teamId: otherTeam.id, name: "机密项目" }).returning();
    const [t1] = await db.insert(tasks).values({ projectId: proj.id, title: "任务一" }).returning();
    const [t2] = await db.insert(tasks).values({ projectId: proj.id, title: "任务二" }).returning();
    const [foreign] = await db.insert(tasks).values({ projectId: otherProj.id, title: "别人的任务" }).returning();
    return { u1, u2, outsider, proj, otherProj, t1, t2, foreign };
  }

  it("跨任务聚合、最新在前，并带作者与任务标题", async () => {
    const { u1, u2, proj, t1, t2 } = await scene();
    await createTaskComment(u1.id, t1.id, "第一个任务的留言");
    await createTaskComment(u2.id, t2.id, "第二个任务的留言");

    const rows = await listProjectComments(u1.id, proj.id);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.content))).toEqual(
      new Set(["第一个任务的留言", "第二个任务的留言"]),
    );
    expect(rows.map((r) => r.taskTitle).sort()).toEqual(["任务一", "任务二"]);
    expect(rows.find((r) => r.taskId === t2.id)!.authorName).toBe("Bob");
    // 时间正序不倒挂（同一事务内时间戳可能相同，故只比较不增）
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i].createdAt.getTime());
    }

    // taskId 过滤只看该任务
    const only = await listProjectComments(u1.id, proj.id, { taskId: t1.id });
    expect(only.map((r) => r.content)).toEqual(["第一个任务的留言"]);

    // limit 生效（默认 20，这里给出更小的值）
    expect(await listProjectComments(u1.id, proj.id, { limit: 1 })).toHaveLength(1);
  });

  it("非项目成员 403；别项目的任务 id 报错而不是漏数据", async () => {
    const { outsider, u1, proj, foreign } = await scene();
    await expect(listProjectComments(outsider.id, proj.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      listProjectComments(u1.id, proj.id, { taskId: foreign.id }),
    ).rejects.toThrow("任务不属于该项目");
  });
});
