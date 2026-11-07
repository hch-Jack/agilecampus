import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { conversations } from "@/db/schema";
import { createUser } from "@/lib/user";
import {
  autoCategorizePersonalConversations,
  listPersonalConversations,
  persistTurn,
  setPersonalConversationCategory,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import { PATCH as patchConversationRoute } from "@/app/api/chat/conversations/[conversationId]/route";
import { POST as categorizeRoute } from "@/app/api/chat/conversations/categorize/route";
import { resetDb } from "./helpers";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

function convCtx(conversationId: string) {
  return { params: Promise.resolve({ conversationId }) };
}

function patchReq(body: unknown) {
  return new Request("http://test/api/chat/conversations/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

describe("会话自动归类", () => {
  beforeEach(resetDb);

  it("首轮对话按关键词自动归类；命中不了保持未分类", async () => {
    const student = await makeUser("student@example.com");
    const projectConv = await startPersonalConversation(student.id);
    const persisted = await persistTurn(
      projectConv.id,
      "帮我看下赤壁演习这个项目的进度",
      "好的",
      [],
    );
    expect(persisted.conversationCategory).toBe("项目与任务");

    const chatty = await startPersonalConversation(student.id);
    expect(chatty.id).not.toBe(projectConv.id);
    const small = await persistTurn(chatty.id, "你好呀", "你好", []);
    expect(small.conversationCategory).toBeNull();

    const listed = await listPersonalConversations(student.id);
    expect(listed.find((c) => c.id === projectConv.id)?.category).toBe("项目与任务");
    expect(listed.find((c) => c.id === chatty.id)?.category).toBeNull();
  });

  it("手动分类后，后续对话不再自动改写", async () => {
    const student = await makeUser("student@example.com");
    const conv = await startPersonalConversation(student.id);
    await persistTurn(conv.id, "把这份报告导出成表格", "好", []);

    await setPersonalConversationCategory(student.id, conv.id, "学习与问答");
    const next = await persistTurn(conv.id, "给张三发条私信转发文件", "好", []);
    expect(next.conversationCategory).toBe("学习与问答");

    const listed = await listPersonalConversations(student.id);
    expect(listed[0].category).toBe("学习与问答");
  });

  it("自动归类批量只补空分类；命中不了的仍是未分类", async () => {
    const student = await makeUser("student@example.com");

    const exported = await startPersonalConversation(student.id);
    await persistTurn(exported.id, "把文件导出成表格", "好", []);
    // 模拟旧数据：分类被清空
    await db
      .update(conversations)
      .set({ category: null })
      .where(eq(conversations.id, exported.id));

    const manual = await startPersonalConversation(student.id);
    await persistTurn(manual.id, "帮我看项目进度", "好", []);
    await setPersonalConversationCategory(student.id, manual.id, "团队与协作");

    const chatty = await startPersonalConversation(student.id);
    await persistTurn(chatty.id, "你好", "你好", []);

    const updated = await autoCategorizePersonalConversations(student.id);
    expect(updated).toBe(1);

    const listed = await listPersonalConversations(student.id);
    const byId = new Map(listed.map((c) => [c.id, c]));
    expect(byId.get(exported.id)?.category).toBe("文件与文档");
    expect(byId.get(manual.id)?.category).toBe("团队与协作");
    expect(byId.get(chatty.id)?.category).toBeNull();
  });

  it("别人的会话改不了分类；非法 id 返回 null", async () => {
    const owner = await makeUser("owner@example.com");
    const outsider = await makeUser("outsider@example.com");
    const conv = await startPersonalConversation(owner.id);

    expect(
      await setPersonalConversationCategory(outsider.id, conv.id, "项目与任务"),
    ).toBeNull();
    expect(await setPersonalConversationCategory(owner.id, "not-a-uuid", "项目与任务")).toBeNull();
    expect(await setPersonalConversationCategory(owner.id, conv.id, "  ")).toMatchObject({
      category: null,
    });
  });
});

describe("会话分类 API", () => {
  beforeEach(resetDb);

  it("PATCH 可单独改分类、恢复未分类、同时改名", async () => {
    const student = await makeUser("student@example.com");
    authMock.userId = student.id;
    const conv = await startPersonalConversation(student.id);

    const res = await patchConversationRoute(
      patchReq({ category: "文件与文档" }),
      convCtx(conv.id),
    );
    expect(res.status).toBe(200);
    let data = (await res.json()) as { conversation: { category: string | null } };
    expect(data.conversation.category).toBe("文件与文档");

    const both = await patchConversationRoute(
      patchReq({ title: "导出资料", category: "项目与任务" }),
      convCtx(conv.id),
    );
    data = await both.json();
    expect(data.conversation).toMatchObject({
      title: "导出资料",
      category: "项目与任务",
    });

    const cleared = await patchConversationRoute(
      patchReq({ category: null }),
      convCtx(conv.id),
    );
    expect((await cleared.json()).conversation.category).toBeNull();
  });

  it("空 body / 超长分类 → 400；别人的会话 → 404", async () => {
    const owner = await makeUser("owner@example.com");
    const student = await makeUser("student@example.com");
    authMock.userId = student.id;
    const mine = await startPersonalConversation(student.id);
    const theirs = await startPersonalConversation(owner.id);

    expect((await patchConversationRoute(patchReq({}), convCtx(mine.id))).status).toBe(400);
    expect(
      (await patchConversationRoute(patchReq({ category: "长".repeat(21) }), convCtx(mine.id)))
        .status,
    ).toBe(400);
    expect(
      (await patchConversationRoute(patchReq({ category: "项目与任务" }), convCtx(theirs.id)))
        .status,
    ).toBe(404);
  });

  it("POST /categorize 返回最新列表，手动分类不被覆盖", async () => {
    const student = await makeUser("student@example.com");
    authMock.userId = student.id;

    const conv = await startPersonalConversation(student.id);
    await persistTurn(conv.id, "帮我看项目进度", "好", []);
    await setPersonalConversationCategory(student.id, conv.id, "学习与问答");
    await db.update(conversations).set({ category: null }).where(eq(conversations.id, conv.id));

    const res = await categorizeRoute();
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      updated: number;
      conversations: { id: string; category: string | null }[];
    };
    expect(data.updated).toBe(1);
    expect(data.conversations[0]).toMatchObject({ id: conv.id, category: "项目与任务" });
  });
});
