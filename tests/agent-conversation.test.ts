import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { db } from "@/db";
import { messages } from "@/db/schema";
import {
  countPersonalConversations,
  deleteAllPersonalConversations,
  deleteChatMessage,
  deletePersonalConversation,
  deriveConversationTitle,
  findPersonalConversation,
  getAssistantPanelData,
  getOrCreateConversation,
  getOrCreatePersonalConversation,
  getPersonalConversation,
  listConversationMessages,
  listPersonalChatHistory,
  listPersonalConversationMessages,
  listPersonalConversations,
  listProjectChatHistory,
  persistTurn,
  recentMessagesForModel,
  renamePersonalConversation,
  resolvePersonalConversation,
  startPersonalConversation,
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

  it("不带 id 的老语义：复用最近一条，且各人的会话互不相干", async () => {
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

  it("listPersonalChatHistory 可取最近 N 条：时间正序、不丢开头的答话、不跨用户", async () => {
    const { student, outsider } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    await persistTurn(conv.id, "甲问", "甲答", []);
    await persistTurn(conv.id, "乙问", "乙答", []);
    const theirs = await getOrCreatePersonalConversation(outsider.id);
    await persistTurn(theirs.id, "别人的问", "别人的答", []);

    // 默认全给，仍是时间正序
    expect((await listPersonalChatHistory(student.id)).map((m) => m.content)).toEqual([
      "甲问",
      "甲答",
      "乙问",
      "乙答",
    ]);
    // 截在问答中间也照实给：这是给人看的转录，不像喂模型的上文那样丢掉开头的答话
    expect((await listPersonalChatHistory(student.id, 3)).map((m) => m.content)).toEqual([
      "甲答",
      "乙问",
      "乙答",
    ]);
    // 别人的会话一条都不串进来
    expect((await listPersonalChatHistory(student.id, 99)).map((m) => m.content)).not.toContain(
      "别人的问",
    );
    expect((await listPersonalChatHistory(outsider.id, 2)).map((m) => m.content)).toEqual([
      "别人的问",
      "别人的答",
    ]);
  });

  it("项目历史非成员被拒", async () => {
    const { outsider, project } = await scene();
    await expect(listProjectChatHistory(outsider.id, project.id)).rejects.toThrow("没有权限");
  });
});

describe("个人多会话", () => {
  beforeEach(resetDb);

  it("已有非空会话后「新对话」会新建；空会话则复用", async () => {
    const { student } = await scene();
    const first = await startPersonalConversation(student.id);
    const again = await startPersonalConversation(student.id);
    expect(again.id).toBe(first.id);
    expect(await countPersonalConversations(student.id)).toBe(1);

    await persistTurn(first.id, "第一句", "第一答", []);
    const second = await startPersonalConversation(student.id);
    expect(second.id).not.toBe(first.id);
    expect(await countPersonalConversations(student.id)).toBe(2);
  });

  it("给了 id 就落那条；没给落最近用过的", async () => {
    const { student } = await scene();
    const a = await startPersonalConversation(student.id);
    await persistTurn(a.id, "甲", "甲答", []);
    const b = await startPersonalConversation(student.id);
    await persistTurn(b.id, "乙", "乙答", []);

    expect((await resolvePersonalConversation(student.id, a.id)).id).toBe(a.id);
    expect((await resolvePersonalConversation(student.id)).id).toBe(b.id);
  });

  it("并发「没有就建」只会建出一条（同用户 advisory lock）", async () => {
    const { student } = await scene();
    const [a, b] = await Promise.all([
      resolvePersonalConversation(student.id),
      startPersonalConversation(student.id),
    ]);
    expect(a.id).toBe(b.id);
    expect(await countPersonalConversations(student.id)).toBe(1);
  });

  it("他人的会话 id 被拒，且不会偷建一条", async () => {
    const { student, owner } = await scene();
    const theirs = await startPersonalConversation(owner.id);
    await expect(resolvePersonalConversation(student.id, theirs.id)).rejects.toThrow("会话不存在");
    expect(await countPersonalConversations(student.id)).toBe(0);
  });

  it("列表按最近活动倒序；读消息先校验归属并带 id", async () => {
    const { student, owner } = await scene();
    const a = await startPersonalConversation(student.id);
    await persistTurn(a.id, "甲问", "甲答", []);
    await new Promise((r) => setTimeout(r, 10));
    const b = await startPersonalConversation(student.id);
    await persistTurn(b.id, "乙问", "乙答", []);

    expect((await listPersonalConversations(student.id)).map((c) => c.id)).toEqual([b.id, a.id]);
    const msgs = await listPersonalConversationMessages(student.id, a.id);
    expect(msgs.map((m) => m.content)).toEqual(["甲问", "甲答"]);
    expect(msgs.every((m) => typeof m.id === "string")).toBe(true);

    await expect(listPersonalConversationMessages(owner.id, a.id)).rejects.toThrow("会话不存在");
  });

  it("首轮自动生成标题，后续轮次不覆盖；改名只动标题", async () => {
    const { student, owner } = await scene();
    const conv = await startPersonalConversation(student.id);
    const turn = await persistTurn(conv.id, "  帮我把调研拆成任务 \n 然后再排期", "好的", []);
    expect(turn.conversationTitle).toBe("帮我把调研拆成任务");

    await persistTurn(conv.id, "另一句话", "另一答", []);
    expect((await getPersonalConversation(student.id, conv.id))?.title).toBe("帮我把调研拆成任务");

    const renamed = await renamePersonalConversation(student.id, conv.id, "  调研排期  ");
    expect(renamed?.title).toBe("调研排期");
    // 别人改不了，也不会顺带把它变空
    expect(await renamePersonalConversation(owner.id, conv.id, "抢")).toBeNull();
    expect((await getPersonalConversation(student.id, conv.id))?.title).toBe("调研排期");
  });

  it("改名、删一条、删全部：都只动本人的 personal 会话", async () => {
    const { student, owner, project } = await scene();
    const mine = await startPersonalConversation(student.id);
    await persistTurn(mine.id, "我的问", "我的答", []);
    const theirs = await startPersonalConversation(owner.id);
    await persistTurn(theirs.id, "他的问", "他的答", []);
    const proj = await getOrCreateConversation(student.id, project.id);
    await persistTurn(proj.id, "项目问", "项目答", []);

    // 别人删不掉我的
    expect(await deletePersonalConversation(owner.id, mine.id)).toBe(false);
    expect(await listPersonalConversationMessages(student.id, mine.id)).toHaveLength(2);

    // 我删自己的一条：消息随外键级联
    expect(await deletePersonalConversation(student.id, mine.id)).toBe(true);
    expect(await getPersonalConversation(student.id, mine.id)).toBeNull();
    expect(await countPersonalConversations(student.id)).toBe(0);
    expect(await countPersonalConversations(owner.id)).toBe(1);

    // 删全部只清本人的；项目会话与别人的会话都不动
    const mine2 = await startPersonalConversation(student.id);
    await persistTurn(mine2.id, "再问", "再答", []);
    expect(await deleteAllPersonalConversations(student.id)).toBe(1);
    expect(await countPersonalConversations(student.id)).toBe(0);
    expect(await countPersonalConversations(owner.id)).toBe(1);
    expect(await listConversationMessages(student.id, proj.id)).toHaveLength(2);
    expect(await listPersonalConversationMessages(owner.id, theirs.id)).toHaveLength(2);
  });
});

describe("persistTurn 的轮次与删除", () => {
  beforeEach(resetDb);

  it("一轮两条共用 turnId，并回传两个消息 id；lastMessageAt 前进", async () => {
    const { student } = await scene();
    const conv = await startPersonalConversation(student.id);
    const first = await persistTurn(conv.id, "甲问", "甲答", []);
    const rows = await db
      .select({ id: messages.id, turnId: messages.turnId })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(
      [first.userMessageId, first.assistantMessageId].sort(),
    );
    expect(rows.every((r) => r.turnId === first.turnId)).toBe(true);

    const firstAt = first.lastMessageAt.getTime();
    await new Promise((r) => setTimeout(r, 10));
    const second = await persistTurn(conv.id, "乙问", "乙答", []);
    expect(second.lastMessageAt.getTime()).toBeGreaterThan(firstAt);
  });

  it("从提问或答复任意一侧删，都会删掉整轮，别的轮次保留", async () => {
    const { student } = await scene();
    const conv = await startPersonalConversation(student.id);
    const first = await persistTurn(conv.id, "甲问", "甲答", []);
    const second = await persistTurn(conv.id, "乙问", "乙答", []);

    const fromUser = await deleteChatMessage(student.id, first.userMessageId);
    expect(fromUser.conversationId).toBe(conv.id);
    expect([...fromUser.deletedIds].sort()).toEqual(
      [first.userMessageId, first.assistantMessageId].sort(),
    );

    let left = await listPersonalConversationMessages(student.id, conv.id);
    expect(left.map((m) => m.content)).toEqual(["乙问", "乙答"]);

    const fromAssistant = await deleteChatMessage(student.id, second.assistantMessageId);
    expect(fromAssistant.deletedIds).toHaveLength(2);
    left = await listPersonalConversationMessages(student.id, conv.id);
    expect(left).toEqual([]);
    // 删空后最近活动回落到 NULL，列表排序会退回 createdAt
    expect(fromAssistant.lastMessageAt).toBeNull();
  });

  it("他人的消息、项目的消息都当「不存在」，且不删任何东西", async () => {
    const { student, owner, project } = await scene();
    const theirs = await startPersonalConversation(owner.id);
    const theirTurn = await persistTurn(theirs.id, "别人的问", "别人的答", []);
    const projConv = await getOrCreateConversation(student.id, project.id);
    const projTurn = await persistTurn(projConv.id, "项目问", "项目答", []);

    await expect(deleteChatMessage(student.id, theirTurn.userMessageId)).rejects.toThrow(
      "消息不存在",
    );
    await expect(deleteChatMessage(student.id, projTurn.userMessageId)).rejects.toThrow(
      "消息不存在",
    );
    expect(await listPersonalConversationMessages(owner.id, theirs.id)).toHaveLength(2);
    expect(await listConversationMessages(student.id, projConv.id)).toHaveLength(2);
  });

  it("老消息没有 turnId：按原始 created_at 配对（微秒只在库里比）", async () => {
    const { student } = await scene();
    const conv = await startPersonalConversation(student.id);
    const at = new Date();
    const inserted = await db
      .insert(messages)
      .values([
        { conversationId: conv.id, role: "user", content: "老问", createdAt: at },
        { conversationId: conv.id, role: "assistant", content: "老答", createdAt: at },
      ])
      .returning({ id: messages.id, turnId: messages.turnId });

    expect(inserted.every((r) => r.turnId === null)).toBe(true);
    const result = await deleteChatMessage(student.id, inserted[1].id);
    expect([...result.deletedIds].sort()).toEqual(inserted.map((r) => r.id).sort());
    expect(await listPersonalConversationMessages(student.id, conv.id)).toEqual([]);
  });
});

describe("getAssistantPanelData", () => {
  beforeEach(resetDb);

  it("没有会话：空列表、null、零消息，且不会顺手建一条", async () => {
    const { student } = await scene();
    expect(await getAssistantPanelData(student.id)).toEqual({
      conversations: [],
      activeId: null,
      messages: [],
    });
    expect(await countPersonalConversations(student.id)).toBe(0);
  });

  it("优先 cookie 指向的那条；无效/别人的 id 回落到最近一条", async () => {
    const { student, owner } = await scene();
    const a = await startPersonalConversation(student.id);
    await persistTurn(a.id, "甲问", "甲答", []);
    await new Promise((r) => setTimeout(r, 10));
    const b = await startPersonalConversation(student.id);
    await persistTurn(b.id, "乙问", "乙答", []);

    const pinned = await getAssistantPanelData(student.id, a.id);
    expect(pinned.activeId).toBe(a.id);
    expect(pinned.messages.map((m) => m.content)).toEqual(["甲问", "甲答"]);
    expect(pinned.conversations.map((c) => c.id)).toEqual([b.id, a.id]);

    expect((await getAssistantPanelData(student.id, "not-a-uuid")).activeId).toBe(b.id);

    const theirs = await startPersonalConversation(owner.id);
    expect((await getAssistantPanelData(student.id, theirs.id)).activeId).toBe(b.id);
  });

  it("会话摘要的日期是 ISO 字符串（Date 不跨服务端边界）", async () => {
    const { student } = await scene();
    const conv = await startPersonalConversation(student.id);
    await persistTurn(conv.id, "甲问", "甲答", []);

    const [summary] = (await getAssistantPanelData(student.id)).conversations;
    expect(typeof summary.createdAt).toBe("string");
    expect(summary.lastMessageAt).toMatch(/T.*Z$/);
  });
});

describe("deriveConversationTitle", () => {
  it("取首行、压空白、最多 24 个码点", () => {
    expect(deriveConversationTitle("  第一行  \n第二行")).toBe("第一行");
    expect(deriveConversationTitle("多个   空白\t字符")).toBe("多个 空白 字符");
    expect(deriveConversationTitle("😀".repeat(24))).toBe("😀".repeat(24));
    expect(deriveConversationTitle("😀".repeat(25))).toBe(`${"😀".repeat(24)}…`);
    expect(deriveConversationTitle("   ")).toBe("");
  });
});

// 喂给模型的「上文」：这组用例盯的是「取最近几条」与「顺序」两件事 —— 一处取反了方向，
// 助手就会拿着最早的几句聊当下，而顺序错了会把问答颠倒过来。
describe("recentMessagesForModel", () => {
  beforeEach(resetDb);

  it("没聊过 → 空", async () => {
    const { student } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    expect(await recentMessagesForModel(conv.id, 10)).toEqual([]);
  });

  it("limit=0 → 空，连查都不查", async () => {
    const { student } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    await persistTurn(conv.id, "一问", "一答", []);
    expect(await recentMessagesForModel(conv.id, 0)).toEqual([]);
  });

  it("取的是**最近**几条，且按时间正序（问在答前）", async () => {
    const { student } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    await persistTurn(conv.id, "甲问", "甲答", []);
    await persistTurn(conv.id, "乙问", "乙答", []);

    expect(await recentMessagesForModel(conv.id, 2)).toEqual([
      { role: "user", content: "乙问" },
      { role: "assistant", content: "乙答" },
    ]);
    // 要的比有的多 → 全给，仍是正序
    expect((await recentMessagesForModel(conv.id, 99)).map((m) => m.content)).toEqual([
      "甲问",
      "甲答",
      "乙问",
      "乙答",
    ]);
    // 奇数条：切在中间（最近 3 条 = 甲答/乙问/乙答），开头的答话被丢掉，剩一问一答
    expect((await recentMessagesForModel(conv.id, 3)).map((m) => m.content)).toEqual([
      "乙问",
      "乙答",
    ]);
  });

  it("开头若是「答」就丢掉（上下文不能以答话打头）", async () => {
    const { student } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    await persistTurn(conv.id, "一问", "一答", []);
    // 最近一条恰好是答话 → 没有可用的上文
    expect(await recentMessagesForModel(conv.id, 1)).toEqual([]);
    expect(await recentMessagesForModel(conv.id, 2)).toEqual([
      { role: "user", content: "一问" },
      { role: "assistant", content: "一答" },
    ]);
  });

  it("只取本会话：别人的个人会话、同一人的项目会话都不串进来", async () => {
    const { student, outsider, project } = await scene();
    const mine = await getOrCreatePersonalConversation(student.id);
    await persistTurn(mine.id, "我的问题", "我的答复", []);

    const theirs = await getOrCreatePersonalConversation(outsider.id);
    await persistTurn(theirs.id, "别人的问题", "别人的答复", []);

    const proj = await getOrCreateConversation(student.id, project.id);
    await persistTurn(proj.id, "项目问题", "项目答复", []);

    expect((await recentMessagesForModel(mine.id, 10)).map((m) => m.content)).toEqual([
      "我的问题",
      "我的答复",
    ]);
  });

  it("同一条 INSERT 落的问与答（created_at 逐字相等）也不会颠倒", async () => {
    const { student } = await scene();
    const conv = await getOrCreatePersonalConversation(student.id);
    await persistTurn(conv.id, "同一刻的问", "同一刻的答", []);
    const rows = await recentMessagesForModel(conv.id, 2);
    expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
