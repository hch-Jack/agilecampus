import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import {
  countPersonalConversations,
  getOrCreateConversation,
  listConversationMessages,
  listPersonalConversationMessages,
  persistTurn,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import { resetDb } from "./helpers";

// 设置页的 server action 读会话、删 cookie、revalidate 当前页 —— 三样都在这里替身，
// 以便在 node 环境直接调用它。
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
  unstable_update: async () => {},
}));

const cookieMock = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock("next/headers", () => ({
  cookies: async () => cookieMock,
}));

const revalidateMock = vi.hoisted(() => ({ path: vi.fn() }));
vi.mock("next/cache", () => ({
  revalidatePath: revalidateMock.path,
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import { resetAssistantHistoryAction } from "@/app/(app)/settings/actions";
import { ASSISTANT_CONVERSATION_COOKIE } from "@/lib/agent/assistant-panel-shared";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, student, project };
}

describe("resetAssistantHistoryAction", () => {
  beforeEach(async () => {
    await resetDb();
    cookieMock.delete.mockClear();
    revalidateMock.path.mockClear();
  });

  it("只删本人的个人会话；项目共享会话别人的会话都保留，并清 cookie", async () => {
    const { owner, student, project } = await scene();

    const mine = await startPersonalConversation(student.id);
    await persistTurn(mine.id, "我的问", "我的答", []);
    const second = await startPersonalConversation(student.id);
    await persistTurn(second.id, "再问", "再答", []);

    const theirs = await startPersonalConversation(owner.id);
    await persistTurn(theirs.id, "他的问", "他的答", []);
    const proj = await getOrCreateConversation(student.id, project.id);
    await persistTurn(proj.id, "项目问", "项目答", []);

    authMock.userId = student.id;
    const state = await resetAssistantHistoryAction(null, new FormData());

    expect(state).toEqual({ ok: true, deleted: 2 });
    expect(await countPersonalConversations(student.id)).toBe(0);
    expect(await countPersonalConversations(owner.id)).toBe(1);
    // 项目共享会话与消息都在
    expect(await listConversationMessages(student.id, proj.id)).toHaveLength(2);
    expect(await listPersonalConversationMessages(owner.id, theirs.id)).toHaveLength(2);

    expect(cookieMock.delete).toHaveBeenCalledWith({
      name: ASSISTANT_CONVERSATION_COOKIE,
      path: "/",
    });
    expect(revalidateMock.path).toHaveBeenCalledWith("/settings");
  });

  it("没登录 → 返回错误，不删任何东西", async () => {
    const { student } = await scene();
    const conv = await startPersonalConversation(student.id);
    await persistTurn(conv.id, "留着", "留着", []);

    authMock.userId = null;
    expect(await resetAssistantHistoryAction(null, new FormData())).toEqual({
      error: "请先登录",
    });
    expect(await countPersonalConversations(student.id)).toBe(1);
    expect(cookieMock.delete).not.toHaveBeenCalled();
  });
});
