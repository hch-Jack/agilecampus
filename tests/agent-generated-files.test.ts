import { beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "@/lib/user";
import {
  listGeneratedFiles,
  persistTurn,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import { GET as filesRoute } from "@/app/api/chat/files/route";
import { resetDb } from "./helpers";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

/** 一轮带工具轨迹的问答：create_file 结果 + open_file 结果各一条 */
async function seedGeneratedTurn(email: string) {
  const user = await makeUser(email);
  const conv = await startPersonalConversation(user.id);
  const turn = await persistTurn(conv.id, "生成一份周报", "已生成。", [
    {
      toolName: "create_file",
      input: { filename: "周报.docx" },
      output: {
        __showFile: true,
        __autoOpen: false,
        url: "/api/assistant/files/11111111-1111-4111-8111-111111111111",
        filename: "周报.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 2048,
      },
    },
    {
      toolName: "open_file",
      input: { source: "task", attachmentId: "x" },
      output: {
        __showFile: true,
        url: "/api/attachments/22222222-2222-4222-8222-222222222222",
        filename: "旧附件.pdf",
        mimeType: "application/pdf",
        size: 512,
      },
    },
    // 同一文件重复出现不算两条
    {
      toolName: "create_file",
      input: { filename: "周报.docx" },
      output: {
        __showFile: true,
        __autoOpen: false,
        url: "/api/assistant/files/11111111-1111-4111-8111-111111111111",
        filename: "周报.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 2048,
      },
    },
  ]);
  return { user, conv, turn };
}

describe("助手生成文件：跨会话列表", () => {
  beforeEach(resetDb);

  it("只列 create_file 的结果，按 url 去重，并带上会话与消息位置", async () => {
    const { user, conv, turn } = await seedGeneratedTurn("student@example.com");

    const files = await listGeneratedFiles(user.id);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      url: "/api/assistant/files/11111111-1111-4111-8111-111111111111",
      filename: "周报.docx",
      size: 2048,
      conversationId: conv.id,
      messageId: turn.assistantMessageId,
    });
    expect(files[0].conversationTitle).toBeTruthy();
    expect(files[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("看不到别人的生成文件", async () => {
    const a = await seedGeneratedTurn("a@example.com");
    await seedGeneratedTurn("b@example.com");
    const files = await listGeneratedFiles(a.user.id);
    expect(files).toHaveLength(1);
    expect(files[0].conversationId).toBe(a.conv.id);
  });

  it("路由返回登录态与文件列表", async () => {
    const { user } = await seedGeneratedTurn("route@example.com");

    authMock.userId = null;
    const denied = await filesRoute();
    expect(denied.status).toBe(401);

    authMock.userId = user.id;
    const res = await filesRoute();
    const data = (await res.json()) as { files: Array<{ filename: string }> };
    expect(res.status).toBe(200);
    expect(data.files.map((f) => f.filename)).toEqual(["周报.docx"]);
  });
});
