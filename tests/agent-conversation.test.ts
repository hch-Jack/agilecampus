import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import {
  findPersonalConversation,
  getOrCreateConversation,
  getOrCreatePersonalConversation,
  persistTurn,
  listConversationMessages,
  listPersonalChatHistory,
  listProjectChatHistory,
} from "@/lib/agent/conversation";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, team, student, outsider, project };
}

describe("getOrCreateConversation", () => {
  beforeEach(resetDb);

  it("首次创建，二次复用同一会话", async () => {
    const { student, project } = await scene();
    const c1 = await getOrCreateConversation(student.id, project.id);
    const c2 = await getOrCreateConversation(student.id, project.id);
    expect(c1.id).toBe(c2.id);
  });

  it("非成员被拒", async () => {
    const { outsider, project } = await scene();
    await expect(getOrCreateConversation(outsider.id, project.id)).rejects.toThrow("没有权限");
  });
});

describe("persistTurn / listConversationMessages", () => {
  beforeEach(resetDb);

  it("落一轮 user+assistant 消息，assistant 携工具轨迹", async () => {
    const { student, project } = await scene();
    const conv = await getOrCreateConversation(student.id, project.id);
    await persistTurn(conv.id, "项目进度如何？", "共有 2 个任务。", [
      { toolName: "query_progress", input: {}, output: { taskTotal: 2 } },
    ]);

    const msgs = await listConversationMessages(student.id, conv.id);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("项目进度如何？");
    expect(msgs[1].role).toBe("assistant");
    expect(msgs[1].content).toBe("共有 2 个任务。");
    expect(msgs[1].toolCalls).toEqual([
      { toolName: "query_progress", input: {}, output: { taskTotal: 2 } },
    ]);
  });

  it("listConversationMessages 非成员被拒", async () => {
    const { student, outsider, project } = await scene();
    const conv = await getOrCreateConversation(student.id, project.id);
    await expect(listConversationMessages(outsider.id, conv.id)).rejects.toThrow("没有权限");
  });
});

describe("个人会话（控制台助手）", () => {
  beforeEach(resetDb);

  it("每人恰一条，且各是各的", async () => {
    const { student, owner } = await scene();
    const first = await getOrCreatePersonalConversation(student.id);
    const again = await getOrCreatePersonalConversation(student.id);
    const other = await getOrCreatePersonalConversation(owner.id);

    expect(again.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(first.kind).toBe("personal");
    expect(first.ownerId).toBe(student.id);
    expect(first.projectId).toBeNull();
  });

  it("只读路径不凭空建会话：findPersonalConversation 返回 null", async () => {
    const { student } = await scene();
    expect(await findPersonalConversation(student.id)).toBeNull();
  });

  it("他人读不了我的个人会话", async () => {
    const { student, owner } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    await persistTurn(conv.id, "我在忙什么", "你在忙甲", []);

    await expect(listConversationMessages(owner.id, conv.id)).rejects.toThrow("没有权限");
    expect(await listConversationMessages(student.id, conv.id)).toHaveLength(2);
  });

  it("个人历史与项目历史互不串台", async () => {
    const { student, outsider, project } = await scene();
    const personal = await getOrCreatePersonalConversation(student.id);
    await persistTurn(personal.id, "个人问题", "个人答复", []);
    const proj = await getOrCreateConversation(student.id, project.id);
    await persistTurn(proj.id, "项目问题", "项目答复", []);

    expect((await listPersonalChatHistory(student.id)).map((m) => m.content)).toEqual([
      "个人问题",
      "个人答复",
    ]);
    expect((await listProjectChatHistory(student.id, project.id)).map((m) => m.content)).toEqual([
      "项目问题",
      "项目答复",
    ]);
    // 从没聊过的人：空历史，而不是别人的
    expect(await listPersonalChatHistory(outsider.id)).toEqual([]);
  });

  it("项目历史非成员被拒", async () => {
    const { outsider, project } = await scene();
    await expect(listProjectChatHistory(outsider.id, project.id)).rejects.toThrow("没有权限");
  });
});
