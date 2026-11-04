import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dmMessages, projects, tasks, teams, teamMembers, users } from "@/db/schema";
import {
  createProjectComment,
  createTaskComment,
  deleteProjectComment,
  listProjectBoardComments,
  listTaskComments,
} from "@/lib/comment";
import { notifyMentionedUsers } from "@/lib/mention";
import { resetDb } from "./helpers";
import { ForbiddenError } from "@/lib/errors";

// 共享夹具：一个团队（admin Alice + 学生 Bob、Carol）+ 一个项目 + 一个任务 + 一个外人
async function scene() {
  const [u1] = await db
    .insert(users)
    .values({ email: "u1@test.com", passwordHash: "x", name: "Alice" })
    .returning();
  const [u2] = await db
    .insert(users)
    .values({ email: "u2@test.com", passwordHash: "x", name: "Bob" })
    .returning();
  const [u3] = await db
    .insert(users)
    .values({ email: "u3@test.com", passwordHash: "x", name: "Carol" })
    .returning();
  const [outsider] = await db
    .insert(users)
    .values({ email: "o@test.com", passwordHash: "x", name: "外人" })
    .returning();
  const [team] = await db.insert(teams).values({ name: "Lab", inviteCode: "123456" }).returning();
  await db.insert(teamMembers).values([
    { teamId: team.id, userId: u1.id, role: "admin" },
    { teamId: team.id, userId: u2.id, role: "student" },
    { teamId: team.id, userId: u3.id, role: "student" },
  ]);
  const [proj] = await db
    .insert(projects)
    .values({ teamId: team.id, name: "研究项目" })
    .returning();
  const [task] = await db.insert(tasks).values({ projectId: proj.id, title: "任务一" }).returning();
  return { u1, u2, u3, outsider, team, proj, task };
}

describe("项目留言板 projectComments", () => {
  beforeEach(resetDb);

  it("成员可列表/创建/删除项目留言；非成员 403", async () => {
    const { u1, u2, outsider, proj } = await scene();

    expect(await listProjectBoardComments(u1.id, proj.id)).toHaveLength(0);

    const c = await createProjectComment(u1.id, proj.id, "项目级讨论");
    expect(c.content).toBe("项目级讨论");

    const rows = await listProjectBoardComments(u2.id, proj.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].authorName).toBe("Alice");

    // 非成员不能列表、不能创建
    await expect(listProjectBoardComments(outsider.id, proj.id)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(createProjectComment(outsider.id, proj.id, "偷渡")).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    // 非作者学生不能删别人的留言；admin 可删任意
    await expect(deleteProjectComment(u2.id, c.id)).rejects.toBeInstanceOf(ForbiddenError);
    await deleteProjectComment(u1.id, c.id);
    expect(await listProjectBoardComments(u1.id, proj.id)).toHaveLength(0);
  });

  it("mentions 读写：带 @ 的留言回 mentionedUserIds；空 @ 回空数组", async () => {
    const { u1, u2, u3, proj } = await scene();
    await createProjectComment(u1.id, proj.id, "@大家 看一下", [u2.id, u3.id]);
    await createProjectComment(u1.id, proj.id, "无 @ 的留言");

    const rows = await listProjectBoardComments(u1.id, proj.id);
    expect(rows).toHaveLength(2);
    const withMentions = rows.find((r) => r.content === "@大家 看一下")!;
    expect(new Set(withMentions.mentionedUserIds)).toEqual(new Set([u2.id, u3.id]));
    const without = rows.find((r) => r.content === "无 @ 的留言")!;
    expect(without.mentionedUserIds).toEqual([]);
  });

  it("任务留言板 mentions 同样落库与读回", async () => {
    const { u1, u2, task } = await scene();
    await createTaskComment(u1.id, task.id, "提醒你", [u2.id]);
    const rows = await listTaskComments(u1.id, task.id);
    expect(rows[0].mentionedUserIds).toEqual([u2.id]);
  });
});

describe("notifyMentionedUsers（@ 私信通知）", () => {
  beforeEach(resetDb);

  it("向每个被 @ 者发一条私信，正文含项目/任务来源；自 @ 被过滤", async () => {
    const { u1, u2, u3, proj, task } = await scene();
    await notifyMentionedUsers({
      actorId: u1.id,
      mentionedUserIds: [u1.id, u2.id, u3.id], // 含作者本人，应被过滤
      scope: "task",
      projectId: proj.id,
      taskId: task.id,
      content: "请审一下",
    });

    const toU2 = await db.select().from(dmMessages).where(eq(dmMessages.recipientId, u2.id));
    const toU3 = await db.select().from(dmMessages).where(eq(dmMessages.recipientId, u3.id));
    const toU1 = await db.select().from(dmMessages).where(eq(dmMessages.recipientId, u1.id));
    expect(toU2).toHaveLength(1);
    expect(toU3).toHaveLength(1);
    expect(toU1).toHaveLength(0); // 自 @ 过滤

    // 正文带项目名 + 任务标题 + 留言内容
    expect(toU2[0].content).toContain("研究项目");
    expect(toU2[0].content).toContain("任务一");
    expect(toU2[0].content).toContain("请审一下");
    expect(toU2[0].senderId).toBe(u1.id);
  });

  it("scope=project：正文带项目名与「项目留言板」，不带任务标题", async () => {
    const { u1, u2, proj } = await scene();
    await notifyMentionedUsers({
      actorId: u1.id,
      mentionedUserIds: [u2.id],
      scope: "project",
      projectId: proj.id,
      content: "项目留言 @ 你",
    });
    const toU2 = await db.select().from(dmMessages).where(eq(dmMessages.recipientId, u2.id));
    expect(toU2).toHaveLength(1);
    expect(toU2[0].content).toContain("研究项目");
    expect(toU2[0].content).toContain("项目留言板");
    expect(toU2[0].content).not.toContain("任务");
  });

  it("错误隔离：被 @ 者不存在时不抛错，其余正常发送（Promise.allSettled）", async () => {
    const { u1, u2, proj, task } = await scene();
    const ghostId = "00000000-0000-0000-0000-000000000000";
    await expect(
      notifyMentionedUsers({
        actorId: u1.id,
        mentionedUserIds: [u2.id, ghostId],
        scope: "task",
        projectId: proj.id,
        taskId: task.id,
        content: "隔离测试",
      }),
    ).resolves.toBeUndefined();
    // 存在的 u2 仍收到
    const toU2 = await db.select().from(dmMessages).where(eq(dmMessages.recipientId, u2.id));
    expect(toU2).toHaveLength(1);
  });

  it("空 targets（仅自 @）直接返回，不发任何私信", async () => {
    const { u1, proj } = await scene();
    await notifyMentionedUsers({
      actorId: u1.id,
      mentionedUserIds: [u1.id],
      scope: "project",
      projectId: proj.id,
      content: "自言自语",
    });
    const all = await db.select().from(dmMessages);
    expect(all).toHaveLength(0);
  });
});
