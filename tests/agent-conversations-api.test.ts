import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import {
  countPersonalConversations,
  getOrCreateConversation,
  listPersonalConversationMessages,
  persistTurn,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import { POST as createConversationRoute } from "@/app/api/chat/conversations/route";
import {
  DELETE as deleteConversationRoute,
  GET as getConversationRoute,
  PATCH as renameConversationRoute,
} from "@/app/api/chat/conversations/[conversationId]/route";
import { DELETE as deleteMessageRoute } from "@/app/api/chat/messages/[messageId]/route";
import { resetDb } from "./helpers";

// 身份只认 session —— 同 tests/agent-personal-api.test.ts 的做法
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

function convCtx(conversationId: string) {
  return { params: Promise.resolve({ conversationId }) };
}

function msgCtx(messageId: string) {
  return { params: Promise.resolve({ messageId }) };
}

function patchReq(body: unknown) {
  return new Request("http://test/api/chat/conversations/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getReq() {
  return new Request("http://test/api/chat/conversations/x");
}

function deleteReq() {
  return new Request("http://test/api/chat/conversations/x", { method: "DELETE" });
}

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

describe("POST /api/chat/conversations", () => {
  beforeEach(resetDb);

  it("未登录 → 401", async () => {
    authMock.userId = null;
    expect((await createConversationRoute()).status).toBe(401);
  });

  it("新建空会话；连续点两次复用同一条，不堆空行", async () => {
    const { student } = await scene();
    authMock.userId = student.id;

    const first = await createConversationRoute();
    expect(first.status).toBe(200);
    const firstData = (await first.json()) as {
      conversation: { id: string; title: string | null; createdAt: string; lastMessageAt: unknown };
    };
    expect(typeof firstData.conversation.id).toBe("string");
    expect(firstData.conversation.title).toBeNull();
    expect(typeof firstData.conversation.createdAt).toBe("string");
    expect(firstData.conversation.lastMessageAt).toBeNull();

    const second = await createConversationRoute();
    const secondData = (await second.json()) as { conversation: { id: string } };
    expect(secondData.conversation.id).toBe(firstData.conversation.id);
    expect(await countPersonalConversations(student.id)).toBe(1);
  });
});

describe("GET /api/chat/conversations/:id", () => {
  beforeEach(resetDb);

  it("未登录 → 401", async () => {
    authMock.userId = null;
    expect((await getConversationRoute(getReq(), convCtx("x"))).status).toBe(401);
  });

  it("返回会话摘要与消息（日期是 ISO 字符串）", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const conv = await startPersonalConversation(student.id);
    await persistTurn(conv.id, "甲问", "甲答", []);

    const res = await getConversationRoute(getReq(), convCtx(conv.id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      conversation: { id: string; createdAt: string };
      messages: { id: string; role: string; content: string }[];
    };
    expect(data.conversation.id).toBe(conv.id);
    expect(typeof data.conversation.createdAt).toBe("string");
    expect(data.messages.map((m) => m.content)).toEqual(["甲问", "甲答"]);
    expect(data.messages.every((m) => typeof m.id === "string")).toBe(true);
  });

  it("别人的会话 → 404；畸形 id → 400", async () => {
    const { student, owner } = await scene();
    authMock.userId = student.id;
    const theirs = await startPersonalConversation(owner.id);

    expect((await getConversationRoute(getReq(), convCtx(theirs.id))).status).toBe(404);
    expect((await getConversationRoute(getReq(), convCtx("not-a-uuid"))).status).toBe(400);
  });
});

describe("PATCH /api/chat/conversations/:id", () => {
  beforeEach(resetDb);

  it("改名并返回新摘要；首尾空白被去掉", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const conv = await startPersonalConversation(student.id);

    const res = await renameConversationRoute(patchReq({ title: "  调研排期  " }), convCtx(conv.id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { conversation: { title: string } };
    expect(data.conversation.title).toBe("调研排期");

    const listed = await listPersonalConversationMessages(student.id, conv.id);
    expect(listed).toEqual([]);
  });

  it("空标题、超长标题 → 400；别人的会话 → 404", async () => {
    const { student, owner } = await scene();
    authMock.userId = student.id;
    const mine = await startPersonalConversation(student.id);
    const theirs = await startPersonalConversation(owner.id);

    expect((await renameConversationRoute(patchReq({ title: "   " }), convCtx(mine.id))).status).toBe(
      400,
    );
    expect(
      (await renameConversationRoute(patchReq({ title: "长".repeat(61) }), convCtx(mine.id))).status,
    ).toBe(400);
    expect(
      (await renameConversationRoute(patchReq({ title: "抢" }), convCtx(theirs.id))).status,
    ).toBe(404);
  });
});

describe("DELETE /api/chat/conversations/:id", () => {
  beforeEach(resetDb);

  it("删掉自己的会话；消息随级联消失，再取 → 404", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const conv = await startPersonalConversation(student.id);
    await persistTurn(conv.id, "甲问", "甲答", []);

    expect((await deleteConversationRoute(deleteReq(), convCtx(conv.id))).status).toBe(200);
    expect(await countPersonalConversations(student.id)).toBe(0);
    expect((await getConversationRoute(getReq(), convCtx(conv.id))).status).toBe(404);
  });

  it("别人的 / 项目的会话 → 404，且都没有被删", async () => {
    const { student, owner, project } = await scene();
    authMock.userId = student.id;
    const theirs = await startPersonalConversation(owner.id);
    const proj = await getOrCreateConversation(student.id, project.id);

    expect((await deleteConversationRoute(deleteReq(), convCtx(theirs.id))).status).toBe(404);
    expect((await deleteConversationRoute(deleteReq(), convCtx(proj.id))).status).toBe(404);
    expect((await getConversationRoute(getReq(), convCtx(theirs.id))).status).toBe(404); // 不是自己的，取也 404
    expect(await countPersonalConversations(owner.id)).toBe(1);
  });

  it("未登录 → 401", async () => {
    authMock.userId = null;
    expect((await deleteConversationRoute(deleteReq(), convCtx("x"))).status).toBe(401);
  });
});

describe("DELETE /api/chat/messages/:id", () => {
  beforeEach(resetDb);

  it("从任一侧删都成对删掉整轮，并回传 deletedIds 与重算后的 lastMessageAt", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const conv = await startPersonalConversation(student.id);
    const turn = await persistTurn(conv.id, "甲问", "甲答", []);

    const res = await deleteMessageRoute(deleteReq(), msgCtx(turn.userMessageId));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      deletedIds: string[];
      conversationId: string;
      lastMessageAt: string | null;
    };
    expect([...data.deletedIds].sort()).toEqual(
      [turn.userMessageId, turn.assistantMessageId].sort(),
    );
    expect(data.conversationId).toBe(conv.id);
    expect(data.lastMessageAt).toBeNull();
    expect(await listPersonalConversationMessages(student.id, conv.id)).toEqual([]);
  });

  it("别人的消息、项目的消息 → 404；畸形 id → 400", async () => {
    const { student, owner, project } = await scene();
    authMock.userId = student.id;
    const theirs = await startPersonalConversation(owner.id);
    const theirTurn = await persistTurn(theirs.id, "别人的问", "别人的答", []);
    const proj = await getOrCreateConversation(student.id, project.id);
    const projTurn = await persistTurn(proj.id, "项目问", "项目答", []);

    expect((await deleteMessageRoute(deleteReq(), msgCtx(theirTurn.userMessageId))).status).toBe(
      404,
    );
    expect((await deleteMessageRoute(deleteReq(), msgCtx(projTurn.userMessageId))).status).toBe(404);
    expect((await deleteMessageRoute(deleteReq(), msgCtx("not-a-uuid"))).status).toBe(400);

    expect(await listPersonalConversationMessages(owner.id, theirs.id)).toHaveLength(2);
  });

  it("未登录 → 401", async () => {
    authMock.userId = null;
    expect((await deleteMessageRoute(deleteReq(), msgCtx("x"))).status).toBe(401);
  });
});
