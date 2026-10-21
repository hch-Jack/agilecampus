import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createGroup, inviteToGroup, listGroupConversations, listMyGroupInvites } from "@/lib/group-chat";
import { listMyPersonalContext } from "@/lib/personal-context";
import { listPersonalChatHistory, listProjectChatHistory } from "@/lib/agent/conversation";
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
});
