import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, listMyTeams } from "@/lib/team";
import { createProject } from "@/lib/project";
import { listTeamResourceUsages } from "@/lib/resource";
import { listTeamLabels } from "@/lib/label";
import { createGroup, inviteToGroup, listGroupConversations, listMyGroupInvites } from "@/lib/group-chat";
import { listMyPersonalContext } from "@/lib/personal-context";
import {
  countPersonalConversations,
  findPersonalConversation,
  listPersonalChatHistory,
  listPersonalConversationMessages,
  listProjectChatHistory,
  persistTurn,
  startPersonalConversation,
} from "@/lib/agent/conversation";
import { POST as chatRoute } from "@/app/api/chat/route";
import { POST as commitRoute } from "@/app/api/chat/commit/route";
import { resetDb } from "./helpers";

// 两处路由都从 session 取身份 —— 照 tests/workbench.test.ts 的惯例 mock 掉 auth
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

// 模型也 mock 掉：回放脚本 + 自增游标（同 tests/agent-orchestrator.test.ts 的注记：
// ai 的 MockLanguageModelV2 数组回放为 1 基，故用函数式回放）。这样路由里跑的是真编排。
const script = vi.hoisted(() => ({ steps: [] as unknown[], cursor: 0 }));
vi.mock("@/lib/agent/model", async () => {
  const { MockLanguageModelV2 } = await import("ai/test");
  return {
    getModel: () =>
      new MockLanguageModelV2({
        doGenerate: async () => script.steps[script.cursor++] as never,
      }),
  };
});

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function useScript(steps: unknown[]) {
  script.steps = steps;
  script.cursor = 0;
}

function toolStep(toolName: string, input: unknown) {
  return {
    finishReason: "tool-calls",
    usage: USAGE,
    content: [
      { type: "tool-call", toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
    ],
    warnings: [],
  };
}

function textStep(text: string) {
  return { finishReason: "stop", usage: USAGE, content: [{ type: "text", text }], warnings: [] };
}

function req(body: unknown) {
  return new Request("http://test/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

describe("POST /api/chat", () => {
  beforeEach(resetDb);

  it("未登录 → 401", async () => {
    authMock.userId = null;
    const res = await chatRoute(req({ scope: "personal", userText: "你好" }));
    expect(res.status).toBe(401);
  });

  it("scope=project 但缺 projectId → 400", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const res = await chatRoute(req({ userText: "进度如何" }));
    expect(res.status).toBe(400);
  });

  it("scope 缺省按项目模式走（老客户端零改动）", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    useScript([textStep("你好。")]);
    const res = await chatRoute(req({ projectId: project.id, userText: "在吗" }));
    expect(res.status).toBe(200);
    expect((await listProjectChatHistory(student.id, project.id)).map((m) => m.content)).toEqual([
      "在吗",
      "你好。",
    ]);
    // 项目回合不该碰个人会话
    expect(await listPersonalChatHistory(student.id)).toEqual([]);
  });

  it("scope=personal → 落个人会话，草案随响应带上各项目的下拉选项", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    useScript([
      toolStep("decompose_tasks", { projectId: project.id, tasks: [{ title: "甲" }] }),
      textStep("已拟好草案，请确认。"),
    ]);

    const res = await chatRoute(req({ scope: "personal", userText: "帮我拆个任务" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      drafts: { tool: string }[];
      options: Record<string, { members: { name: string }[] }>;
    };
    expect(data.drafts[0].tool).toBe("decompose_tasks");
    expect(data.options[project.id].members.map((m) => m.name).sort()).toEqual([
      "owner",
      "student",
    ]);

    expect((await listPersonalChatHistory(student.id)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(await listProjectChatHistory(student.id, project.id)).toEqual([]);
  });

  it("scope=personal + projectId：焦点项目生效，仍落个人会话", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    useScript([toolStep("list_comments", {}), textStep("留言板是空的。")]);

    const res = await chatRoute(
      req({ scope: "personal", projectId: project.id, userText: "这个项目有留言吗？" }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { toolTrace: { toolName: string }[] };
    // 项目专属工具真的放出来了（没有焦点时个人工具面里没有它）
    expect(data.toolTrace.map((t) => t.toolName)).toContain("list_comments");

    expect((await listPersonalChatHistory(student.id)).map((m) => m.content)).toEqual([
      "这个项目有留言吗？",
      "留言板是空的。",
    ]);
    expect(await listProjectChatHistory(student.id, project.id)).toEqual([]);
  });

  it("scope=personal + 无权焦点的项目 → 403，且不建个人会话", async () => {
    const { outsider, project } = await scene();
    authMock.userId = outsider.id;
    useScript([textStep("不该到这里")]);

    const res = await chatRoute(
      req({ scope: "personal", projectId: project.id, userText: "偷看进度" }),
    );
    expect(res.status).toBe(403);
    expect(await findPersonalConversation(outsider.id)).toBeNull();
  });

  it("scope=personal + 畸形 projectId → 400（不把非法 id 当焦点发下去）", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const res = await chatRoute(
      req({ scope: "personal", projectId: "not-a-uuid", userText: "你好" }),
    );
    expect(res.status).toBe(400);
    expect(await findPersonalConversation(student.id)).toBeNull();
  });

  it("响应带回会话与轮次 id（客户端据此寻址和成对删除）", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    useScript([textStep("在。")]);

    const res = await chatRoute(req({ scope: "personal", userText: "在吗" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(typeof data.conversationId).toBe("string");
    expect(data.conversationTitle).toBe("在吗");
    expect(typeof data.conversationCreatedAt).toBe("string");
    expect(data.lastMessageAt).toMatch(/T.*Z$/);
    expect(typeof data.turnId).toBe("string");
    expect(typeof data.userMessageId).toBe("string");
    expect(typeof data.assistantMessageId).toBe("string");
  });

  it("open_page 的跳转意图随响应下发 navigations", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    useScript([
      toolStep("open_page", { target: "project", projectId: project.id }),
      textStep("已为你打开赤壁演习。"),
    ]);

    const res = await chatRoute(req({ scope: "personal", userText: "打开赤壁演习" }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { navigations: { label: string; href: string }[] };
    // 路径与标签都由服务端生成，模型只报了目标与 id
    expect(data.navigations).toEqual([
      { label: "赤壁演习", href: `/projects/${project.id}` },
    ]);
  });

  it("scope=personal + conversationId：落指定会话，最近一条不被追加", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const older = await startPersonalConversation(student.id);
    await persistTurn(older.id, "旧问", "旧答", []);
    const latest = await startPersonalConversation(student.id);
    await persistTurn(latest.id, "较新问", "较新答", []);

    useScript([textStep("好的。")]);
    const res = await chatRoute(
      req({ scope: "personal", conversationId: older.id, userText: "追加到旧会话" }),
    );
    expect(res.status).toBe(200);

    expect(
      (await listPersonalConversationMessages(student.id, older.id)).map((m) => m.content),
    ).toEqual(["旧问", "旧答", "追加到旧会话", "好的。"]);
    expect(
      (await listPersonalConversationMessages(student.id, latest.id)).map((m) => m.content),
    ).toEqual(["较新问", "较新答"]);
  });

  it("别人的 / 畸形的 conversationId 都被拒，且不新建", async () => {
    const { student, owner } = await scene();
    authMock.userId = student.id;
    const theirs = await startPersonalConversation(owner.id);
    useScript([textStep("不该到这里")]);

    const foreign = await chatRoute(
      req({ scope: "personal", conversationId: theirs.id, userText: "偷看" }),
    );
    expect(foreign.status).toBe(403);

    const malformed = await chatRoute(
      req({ scope: "personal", conversationId: "not-a-uuid", userText: "你好" }),
    );
    expect(malformed.status).toBe(400);

    expect(await countPersonalConversations(student.id)).toBe(0);
  });

  it("scope=project 带 conversationId → 400（项目共享会话不走这套）", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    useScript([textStep("不该到这里")]);

    const res = await chatRoute(
      req({
        scope: "project",
        projectId: project.id,
        conversationId: "3f0f2a7e-8b1c-4d8e-9f00-123456789abc",
        userText: "你好",
      }),
    );
    expect(res.status).toBe(400);
    expect(await listProjectChatHistory(student.id, project.id)).toEqual([]);
  });
});

describe("POST /api/chat/commit", () => {
  beforeEach(resetDb);

  it("scope=personal + save_personal_context → 落库归发话人、来源 agent", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "save_personal_context",
        draft: { entries: [{ content: "每周三下午有课" }, { content: "私事", visibility: "private" }] },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).committed).toBe(2);

    const rows = await listMyPersonalContext(student.id);
    expect(rows.map((r) => [r.content, r.visibility, r.source])).toEqual([
      ["每周三下午有课", "shared", "agent"],
      ["私事", "private", "agent"],
    ]);
  });

  it("草案里夹带别人的 userId 也改不了归属（身份只认 session）", async () => {
    const { student, outsider } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "save_personal_context",
        draft: { entries: [{ content: "这条算谁的" }], userId: outsider.id },
      }),
    );
    expect(res.status).toBe(200);

    expect((await listMyPersonalContext(student.id)).map((r) => r.content)).toEqual([
      "这条算谁的",
    ]);
    expect(await listMyPersonalContext(outsider.id)).toEqual([]);
  });

  it("scope=personal 的草案落到无权限的项目 → 403", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "decompose_tasks",
        draft: { projectId: "00000000-0000-0000-0000-000000000000", tasks: [{ title: "越权" }] },
      }),
    );
    expect(res.status).toBe(403);
    void project;
  });

  it("scope=personal + create_project：非该团队管理员被拒", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "create_project",
        draft: { teamId: project.teamId, name: "学生的项目" },
      }),
    );
    // 团队成员但不是 admin：createProject 内部 requireTeamRole 拦下
    expect(res.status).toBe(403);
  });

  it("项目页不认个人上下文工具（scope=project + save_personal_context）→ 400", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "project",
        projectId: project.id,
        tool: "save_personal_context",
        draft: { entries: [{ content: "不该从项目页进来" }] },
      }),
    );
    expect(res.status).toBe(400);
    expect(await listMyPersonalContext(student.id)).toEqual([]);
  });

  it("scope=personal + respond_group_invite：确认后真正接受，展示字段被忽略", async () => {
    const { owner, student } = await scene();
    const group = await createGroup(owner.id, "讨论组", []);
    await inviteToGroup(owner.id, group.id, "student");
    const [invite] = await listMyGroupInvites(student.id);
    expect(invite.groupName).toBe("讨论组");

    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "respond_group_invite",
        // groupName / inviterName 只是卡片展示字段，落库 zod 会剥掉
        draft: {
          inviteId: invite.inviteId,
          accept: true,
          groupName: "伪造的群名",
          inviterName: "伪造的人",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).committed).toBe(1);

    expect((await listGroupConversations(student.id)).map((c) => c.groupId)).toContain(group.id);
    expect(await listMyGroupInvites(student.id)).toEqual([]);
  });

  it("项目页不认群邀请工具（scope=project + respond_group_invite）→ 400", async () => {
    const { owner, student, project } = await scene();
    const group = await createGroup(owner.id, "讨论组", []);
    await inviteToGroup(owner.id, group.id, "student");
    const [invite] = await listMyGroupInvites(student.id);

    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "project",
        projectId: project.id,
        tool: "respond_group_invite",
        draft: { inviteId: invite.inviteId, accept: true },
      }),
    );
    expect(res.status).toBe(400);
    // 请求被拒，邀请原样留着
    expect(await listMyGroupInvites(student.id)).toHaveLength(1);
  });

  it("个人 scope 的改任务草案照常落库（projectId 从草案里取）", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "decompose_tasks",
        draft: { projectId: project.id, tasks: [{ title: "甲" }, { title: "乙" }] },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).committed).toBe(2);
  });

  it("个人 scope 的资源占用草案：墙面时间按用户时区落库", async () => {
    const { student, team } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "create_resource_usage",
        draft: {
          teamId: team.id,
          teamName: "东吴实验室", // 展示字段，落库 zod 剥掉
          resourceName: "GPU-01",
          purpose: "训练模型",
          startTime: "2026-11-01T09:30",
          endTime: "2026-11-01T11:00",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).committed).toBe(1);

    const { usages } = await listTeamResourceUsages(student.id, team.id);
    // 默认时区 Asia/Shanghai：09:30 当地 = 01:30Z
    expect(usages[0].startTime.toISOString()).toBe("2026-11-01T01:30:00.000Z");
    expect(usages[0].endTime?.toISOString()).toBe("2026-11-01T03:00:00.000Z");
  });

  it("scope=personal + create_team：确认后建团，发起人为 admin", async () => {
    const { student } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({ scope: "personal", tool: "create_team", draft: { name: "  新团队  " } }),
    );
    expect(res.status).toBe(200);

    const names = (await listMyTeams(student.id)).map((t) => [t.name, t.role]);
    expect(names).toEqual(expect.arrayContaining([["新团队", "admin"]]));
  });

  it("scope=personal + join_team：凭邀请码入团", async () => {
    const { team } = await scene();
    const latecomer = await makeUser("late@example.com");
    authMock.userId = latecomer.id;
    const res = await commitRoute(
      req({
        scope: "personal",
        tool: "join_team",
        // teamName 是卡片展示字段，落库 zod 剥掉
        draft: { inviteCode: team.inviteCode, teamName: "伪造的团队名" },
      }),
    );
    expect(res.status).toBe(200);

    expect((await listMyTeams(latecomer.id)).map((t) => t.id)).toEqual([team.id]);
  });

  it("项目页不认建团工具（scope=project + create_team）→ 400", async () => {
    const { student, project } = await scene();
    authMock.userId = student.id;
    const res = await commitRoute(
      req({
        scope: "project",
        projectId: project.id,
        tool: "create_team",
        draft: { name: "不该从项目页建团" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await listMyTeams(student.id)).map((t) => t.name)).not.toContain(
      "不该从项目页建团",
    );
  });

  it("项目页不认标签工具（scope=project + create_label）→ 400", async () => {
    const { owner, project, team } = await scene();
    authMock.userId = owner.id;
    const res = await commitRoute(
      req({
        scope: "project",
        projectId: project.id,
        tool: "create_label",
        draft: { teamId: team.id, name: "论文" },
      }),
    );
    expect(res.status).toBe(400);
    expect((await listTeamLabels(owner.id, team.id)).map((l) => l.name)).toEqual([]);
  });
});
