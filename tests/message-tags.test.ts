import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "@/lib/user";
import {
  deletePersonalConversation,
  listPersonalConversationMessages,
  persistTurn,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import {
  addMessageTag,
  listMessageTags,
  listMessageTagsForMessages,
  listMessagesByTag,
  removeMessageTag,
} from "@/lib/agent/message-tags";
import { AppError } from "@/lib/errors";
import { POST as addTagRoute, DELETE as removeTagRoute } from "@/app/api/chat/messages/[messageId]/tags/route";
import { GET as tagsRoute } from "@/app/api/chat/tags/route";
import { resetDb } from "./helpers";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

function messageCtx(messageId: string) {
  return { params: Promise.resolve({ messageId }) };
}

function postReq(body: unknown) {
  return new Request("http://test/api/chat/messages/x/tags", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 建一条个人会话并落一轮问答，返回用得到的 id */
async function seedTurn(email: string) {
  const user = await makeUser(email);
  const conv = await startPersonalConversation(user.id);
  const turn = await persistTurn(conv.id, "帮我看下项目进度", "当前进度 60%。", []);
  return { user, conv, turn };
}

describe("消息标签：库层", () => {
  beforeEach(resetDb);

  it("给助手消息打标签、按标签查历史、按消息读标签", async () => {
    const { user, conv, turn } = await seedTurn("student@example.com");

    const tags = await addMessageTag(user.id, turn.assistantMessageId, "  进度  ");
    expect(tags).toEqual(["进度"]);

    const summaries = await listMessageTags(user.id);
    expect(summaries).toEqual([{ tag: "进度", count: 1 }]);

    const messages = await listMessagesByTag(user.id, "进度");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: turn.assistantMessageId,
      conversationId: conv.id,
      conversationTitle: expect.any(String),
      content: "当前进度 60%。",
      tags: ["进度"],
    });

    const byMessage = await listMessageTagsForMessages(user.id, [turn.assistantMessageId]);
    expect(byMessage.get(turn.assistantMessageId)).toEqual(["进度"]);

    // 会话读回时也带着「我的」标签
    const loaded = await listPersonalConversationMessages(user.id, conv.id);
    const assistant = loaded.find((m) => m.id === turn.assistantMessageId);
    expect(assistant?.tags).toEqual(["进度"]);
  });

  it("重复添加幂等；多个标签按添加顺序；撤销后查不到", async () => {
    const { user, turn } = await seedTurn("student@example.com");
    await addMessageTag(user.id, turn.assistantMessageId, "进度");
    expect(await addMessageTag(user.id, turn.assistantMessageId, "进度")).toEqual(["进度"]);
    const both = await addMessageTag(user.id, turn.assistantMessageId, "周报");
    expect(both).toHaveLength(2);
    expect([...both!].sort()).toEqual(["周报", "进度"].sort());
    expect(await listMessageTags(user.id)).toHaveLength(2);

    expect(await removeMessageTag(user.id, turn.assistantMessageId, "进度")).toBe(true);
    expect(await removeMessageTag(user.id, turn.assistantMessageId, "进度")).toBe(false);
    expect(await listMessagesByTag(user.id, "进度")).toHaveLength(0);
    expect(await listMessagesByTag(user.id, "周报")).toHaveLength(1);
  });

  it("空标签报错；超长标签按码点截断", async () => {
    const { user, turn } = await seedTurn("student@example.com");
    await expect(addMessageTag(user.id, turn.assistantMessageId, "   ")).rejects.toBeInstanceOf(
      AppError,
    );

    const tags = await addMessageTag(user.id, turn.assistantMessageId, "长".repeat(30));
    expect(tags).toHaveLength(1);
    expect(Array.from(tags![0])).toHaveLength(20);
  });

  it("只能给自己个人会话里的助手消息打标：用户消息 / 别人的消息都不行", async () => {
    const { user, turn } = await seedTurn("student@example.com");
    const other = await makeUser("other@example.com");

    expect(await addMessageTag(user.id, turn.userMessageId, "进度")).toBeNull();
    expect(await addMessageTag(other.id, turn.assistantMessageId, "偷看")).toBeNull();
    expect(await addMessageTag(user.id, "not-a-uuid", "进度")).toBeNull();

    // 别人查不到我的标签、我的消息
    expect(await listMessageTags(other.id)).toEqual([]);
    expect(await listMessagesByTag(other.id, "偷看")).toEqual([]);
  });

  it("删除会话时标签随消息级联删除", async () => {
    const { user, conv, turn } = await seedTurn("student@example.com");
    await addMessageTag(user.id, turn.assistantMessageId, "进度");

    expect(await deletePersonalConversation(user.id, conv.id)).toBe(true);
    expect(await listMessageTags(user.id)).toEqual([]);
  });
});

describe("消息标签：HTTP 路由", () => {
  beforeEach(resetDb);

  it("POST 加标签；DELETE 撤销；GET 列表与按标签查询", async () => {
    const { user, conv, turn } = await seedTurn("student@example.com");
    authMock.userId = user.id;

    const add = await addTagRoute(
      postReq({ tag: "进度" }),
      messageCtx(turn.assistantMessageId),
    );
    expect(add.status).toBe(200);
    expect(await add.json()).toEqual({ tags: ["进度"] });

    const list = await tagsRoute(new Request("http://test/api/chat/tags"));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ tags: [{ tag: "进度", count: 1 }] });

    const search = await tagsRoute(
      new Request(`http://test/api/chat/tags?tag=${encodeURIComponent("进度")}`),
    );
    const found = (await search.json()) as {
      tag: string;
      messages: { messageId: string; conversationId: string }[];
    };
    expect(found.tag).toBe("进度");
    expect(found.messages[0]).toMatchObject({
      messageId: turn.assistantMessageId,
      conversationId: conv.id,
    });

    const remove = await removeTagRoute(
      new Request(
        `http://test/api/chat/messages/${turn.assistantMessageId}/tags?tag=${encodeURIComponent("进度")}`,
        { method: "DELETE" },
      ),
      messageCtx(turn.assistantMessageId),
    );
    expect(remove.status).toBe(200);
    expect(await listMessageTags(user.id)).toEqual([]);
  });

  it("未登录 401；空标签 400；别人的消息 404", async () => {
    const { user, turn } = await seedTurn("student@example.com");
    const other = await makeUser("other@example.com");

    authMock.userId = null;
    expect((await addTagRoute(postReq({ tag: "进度" }), messageCtx(turn.assistantMessageId))).status).toBe(401);
    expect((await tagsRoute(new Request("http://test/api/chat/tags"))).status).toBe(401);

    authMock.userId = user.id;
    expect((await addTagRoute(postReq({ tag: "   " }), messageCtx(turn.assistantMessageId))).status).toBe(400);
    expect((await addTagRoute(postReq({ tag: "长".repeat(21) }), messageCtx(turn.assistantMessageId))).status).toBe(400);
    expect(
      (await addTagRoute(postReq({ tag: "进度" }), messageCtx("not-a-uuid"))).status,
    ).toBe(400);

    authMock.userId = other.id;
    expect(
      (await addTagRoute(postReq({ tag: "进度" }), messageCtx(turn.assistantMessageId))).status,
    ).toBe(404);
  });
});
