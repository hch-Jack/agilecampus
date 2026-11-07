import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createPersonalContext, listMyPersonalContext } from "@/lib/personal-context";
import { getAiHistoryLimit, setAiHistoryLimit } from "@/lib/agent/memory";
import {
  listPersonalConversationMessages,
  listPersonalConversations,
  persistTurn,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import {
  MEMORY_EXPORT_FORMAT,
  MEMORY_EXPORT_VERSION,
  exportAssistantMemory,
  importAssistantMemory,
  parseMemoryExport,
} from "@/lib/agent/memory-transfer";
import { AppError } from "@/lib/errors";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function seedConversation(userId: string, turns: [string, string][]) {
  const conv = await startPersonalConversation(userId);
  for (const [userText, assistantText] of turns) {
    await persistTurn(conv.id, userText, assistantText, []);
  }
  return conv;
}

describe("exportAssistantMemory：导出的快照", () => {
  beforeEach(resetDb);

  it("装个人上下文 + 个人会话消息 + 偏好，且只导自己的", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await createPersonalContext(a.id, [
      { content: "我在做毕业设计", visibility: "private", source: "manual" },
    ]);
    await setAiHistoryLimit(a.id, 12);
    await seedConversation(a.id, [
      ["帮我看进度", "好的，正在看。"],
      ["谢谢", "不客气。"],
    ]);
    // 别人的数据不该混进来
    await createPersonalContext(b.id, [{ content: "B 的背景" }]);
    await seedConversation(b.id, [["B 的对话", "B 的回答"]]);

    const doc = await exportAssistantMemory(a.id);

    expect(doc.format).toBe(MEMORY_EXPORT_FORMAT);
    expect(doc.version).toBe(MEMORY_EXPORT_VERSION);
    expect(doc.settings).toEqual({ historyLimit: 12 });
    expect(doc.contexts.map((c) => c.content)).toEqual(["我在做毕业设计"]);
    expect(doc.contexts[0]).toMatchObject({ visibility: "private", source: "manual" });
    expect(doc.conversations).toHaveLength(1);
    // 同一轮问答时间相同：问在上、答在下
    expect(doc.conversations[0].messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(doc.conversations[0].messages.map((m) => m.content)).toEqual([
      "帮我看进度",
      "好的，正在看。",
      "谢谢",
      "不客气。",
    ]);
    expect(doc.conversations[0].title).toBe("帮我看进度");
  });
});

describe("importAssistantMemory：只补不回滚", () => {
  beforeEach(resetDb);

  it("导出 → 换账号导入：上下文、会话、消息、时间先后都恢复", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await createPersonalContext(a.id, [
      { content: "我做的是校园协作平台", visibility: "shared", source: "agent" },
    ]);
    await seedConversation(a.id, [
      ["第一问", "第一答"],
      ["第二问", "第二答"],
    ]);
    await setAiHistoryLimit(a.id, 33);

    const doc = await exportAssistantMemory(a.id);
    const result = await importAssistantMemory(b.id, JSON.parse(JSON.stringify(doc)));

    expect(result).toEqual({
      contextsAdded: 1,
      contextsSkipped: 0,
      conversationsAdded: 1,
      messagesAdded: 4,
    });

    const contexts = await listMyPersonalContext(b.id);
    expect(contexts.map((c) => c.content)).toEqual(["我做的是校园协作平台"]);
    expect(contexts[0]).toMatchObject({ visibility: "shared", source: "agent" });

    const conversations = await listPersonalConversations(b.id);
    expect(conversations).toHaveLength(1);
    // 标题随第一句问话派生（persistTurn 里发生，seedConversation 返回的行是旧快照）
    expect(conversations[0].title).toBe("第一问");

    const messages = await listPersonalConversationMessages(b.id, conversations[0].id);
    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:第一问",
      "assistant:第一答",
      "user:第二问",
      "assistant:第二答",
    ]);
  });

  it("同一份文件导两次：上下文不翻倍，会话按用户选择再建一份", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await createPersonalContext(a.id, [{ content: "记住这一条" }]);
    await seedConversation(a.id, [["问", "答"]]);
    const doc = await exportAssistantMemory(a.id);

    expect(await importAssistantMemory(b.id, doc)).toMatchObject({
      contextsAdded: 1,
      conversationsAdded: 1,
    });
    expect(await importAssistantMemory(b.id, doc)).toMatchObject({
      contextsAdded: 0,
      contextsSkipped: 1,
      conversationsAdded: 1,
    });
    expect(await listMyPersonalContext(b.id)).toHaveLength(1);
    expect(await listPersonalConversations(b.id)).toHaveLength(2);
  });

  it("导入不改「记得多少上文」", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    await setAiHistoryLimit(a.id, 40);
    await setAiHistoryLimit(b.id, 3);
    const doc = await exportAssistantMemory(a.id);

    await importAssistantMemory(b.id, doc);
    expect(await getAiHistoryLimit(b.id)).toBe(3);
  });

  it("受 50 条上下文配额约束：装不下的跳过并报数", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    const existing = Array.from({ length: 49 }, (_, i) => ({ content: `已有 ${i}` }));
    await createPersonalContext(b.id, existing);
    await createPersonalContext(a.id, [
      { content: "新增一" },
      { content: "新增二" },
      { content: "新增三" },
    ]);
    const doc = await exportAssistantMemory(a.id);

    const result = await importAssistantMemory(b.id, doc);
    expect(result.contextsAdded).toBe(1);
    expect(result.contextsSkipped).toBe(2);
    expect(await listMyPersonalContext(b.id)).toHaveLength(50);

    // 配额已满时再导：一条也不落
    expect(await importAssistantMemory(b.id, doc)).toMatchObject({
      contextsAdded: 0,
      contextsSkipped: 3,
    });
  });

  it("没消息的会话不建空行；文件里的身份字段一概不认", async () => {
    const b = await makeUser("b@example.com");
    const doc = {
      format: MEMORY_EXPORT_FORMAT,
      version: MEMORY_EXPORT_VERSION,
      contexts: [],
      conversations: [
        { title: "空会话", messages: [] },
        {
          title: "别人的会话",
          createdAt: "2026-01-01T00:00:00.000Z",
          messages: [
            { role: "user", content: "我是谁？", ownerId: "00000000-0000-0000-0000-000000000000" },
            { role: "assistant", content: "你是 B。" },
          ],
        },
      ],
    };

    const result = await importAssistantMemory(b.id, doc);
    expect(result).toMatchObject({ conversationsAdded: 1, messagesAdded: 2 });
    const conversations = await listPersonalConversations(b.id);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].title).toBe("别人的会话");
    const messages = await listPersonalConversationMessages(b.id, conversations[0].id);
    expect(messages).toHaveLength(2);
  });

  it("不是导出文件 / 版本不对：解析阶段就拒，且说明卡在哪", async () => {
    const b = await makeUser("b@example.com");
    expect(() => parseMemoryExport({ format: "something-else", version: 1 })).toThrow(
      "这不是 AgileCampus 助手记忆的导出文件",
    );
    expect(() =>
      parseMemoryExport({ format: MEMORY_EXPORT_FORMAT, version: 99 }),
    ).toThrow("导出文件版本不受支持");
    await expect(importAssistantMemory(b.id, { format: MEMORY_EXPORT_FORMAT })).rejects.toThrow(
      AppError,
    );
  });

  it("缺布尔/枚举字段时用默认值补上，不因小瑕疵整份拒收", async () => {
    const b = await makeUser("b@example.com");
    const doc = {
      format: MEMORY_EXPORT_FORMAT,
      version: MEMORY_EXPORT_VERSION,
      contexts: [{ content: "只有正文" }],
      conversations: [],
    };
    await importAssistantMemory(b.id, doc);
    expect((await listMyPersonalContext(b.id))[0]).toMatchObject({
      content: "只有正文",
      visibility: "shared",
      source: "manual",
    });
  });
});
