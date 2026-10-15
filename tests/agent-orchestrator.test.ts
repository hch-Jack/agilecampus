import { describe, it, expect, beforeEach } from "vitest";
import { MockLanguageModelV2 } from "ai/test";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { createPersonalContext, listMyPersonalContext } from "@/lib/personal-context";
import {
  listConversationMessages,
  listPersonalChatHistory,
  listProjectChatHistory,
} from "@/lib/agent/conversation";
import { setAiHistoryLimit } from "@/lib/agent/memory";
import { runAgentTurn } from "@/lib/agent/orchestrator";
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

// 录制脚本：第一轮请求调 query_progress 工具，第二轮据结果出文本。
// 注：ai@5.0.218 的 MockLanguageModelV2 数组回放为 1 基（doGenerate[calls.length]，push 后取值会跳过 [0]），
// 故改用函数式回放 + 自增游标，逐轮返回脚本，确保工具循环真正被驱动。
function replayModel() {
  const script: Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>[] = [
    {
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      content: [
        { type: "tool-call", toolCallId: "call-1", toolName: "query_progress", input: "{}" },
      ],
      warnings: [],
    },
    {
      finishReason: "stop",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      content: [{ type: "text", text: "该项目当前共有 1 个任务，均待办。" }],
      warnings: [],
    },
  ];
  let cursor = 0;
  return new MockLanguageModelV2({ doGenerate: async () => script[cursor++] });
}

describe("runAgentTurn（replay）", () => {
  beforeEach(resetDb);

  it("模型调 query_progress → 落库 → 出文本", async () => {
    const { student, project } = await scene();
    await createTask(student.id, project.id, { title: "甲" });

    const result = await runAgentTurn({
      actorId: student.id,
      projectId: project.id,
      userText: "项目进度如何？",
      model: replayModel(),
    });

    expect(result.text).toContain("1 个任务");

    const msgs = await listConversationMessages(student.id, result.conversationId);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[1].role).toBe("assistant");
    const trace = msgs[1].toolCalls as { toolName: string }[];
    expect(trace.some((e) => e.toolName === "query_progress")).toBe(true);
  });

  it("非成员被拒（编排入口经会话创建收敛权限）", async () => {
    const { outsider, project } = await scene();
    await expect(
      runAgentTurn({
        actorId: outsider.id,
        projectId: project.id,
        userText: "偷看进度",
        model: replayModel(),
      }),
    ).rejects.toThrow("没有权限");
  });

  it("越权项目 id 亦被拒", async () => {
    const { student } = await scene();
    await expect(
      runAgentTurn({
        actorId: student.id,
        projectId: "00000000-0000-0000-0000-000000000000",
        userText: "偷看",
        model: replayModel(),
      }),
    ).rejects.toThrow("没有权限");
  });
});

// 同上：函数式回放 + 自增游标；额外把每次 doGenerate 的入参收下来，用于断言系统提示的内容
function capturingReplay(
  script: Awaited<ReturnType<MockLanguageModelV2["doGenerate"]>>[],
) {
  const prompts: unknown[] = [];
  let cursor = 0;
  const model = new MockLanguageModelV2({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      return script[cursor++];
    },
  });
  return { model, prompts };
}

const USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function toolCallStep(toolName: string, input: unknown) {
  return {
    finishReason: "tool-calls" as const,
    usage: USAGE,
    content: [
      { type: "tool-call" as const, toolCallId: `call-${toolName}`, toolName, input: JSON.stringify(input) },
    ],
    warnings: [],
  };
}

function textStep(text: string) {
  return {
    finishReason: "stop" as const,
    usage: USAGE,
    content: [{ type: "text" as const, text }],
    warnings: [],
  };
}

describe("runAgentTurn（个人 scope：控制台助手）", () => {
  beforeEach(resetDb);

  it("跨项目问进度：落在个人会话里，不会顺手建出项目会话", async () => {
    const { student, project } = await scene();
    await createTask(student.id, project.id, { title: "甲", assigneeId: student.id });
    await createPersonalContext(student.id, [{ content: "每周三下午有课", visibility: "private" }]);

    const { model, prompts } = capturingReplay([
      toolCallStep("list_tasks", { projectId: project.id }),
      textStep("你名下有 1 个待办。"),
    ]);
    const result = await runAgentTurn({
      actorId: student.id,
      userText: "我有哪些活？",
      scope: { kind: "personal" },
      model,
    });

    expect(result.text).toContain("1 个待办");
    expect((await listPersonalChatHistory(student.id)).map((m) => m.content)).toEqual([
      "我有哪些活？",
      "你名下有 1 个待办。",
    ]);
    // 个人回合不该在项目页留下痕迹
    expect(await listProjectChatHistory(student.id, project.id)).toEqual([]);

    // 系统提示用的是「我」的快照：含跨项目段，也含只给自己看的条目
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("本次工作范围");
    expect(prompt).toContain("我参与的项目");
    expect(prompt).toContain("每周三下午有课（仅自己）");
  });

  it("借 save_personal_context 拟上下文草案，只产草案不落库", async () => {
    const { student } = await scene();
    const { model } = capturingReplay([
      toolCallStep("save_personal_context", { entries: [{ content: "导师要求月底交初稿" }] }),
      textStep("已拟好草案，请确认。"),
    ]);
    const result = await runAgentTurn({
      actorId: student.id,
      userText: "记住我这月底要交初稿",
      scope: { kind: "personal" },
      model,
    });

    expect(result.drafts).toEqual([
      {
        __draft: true,
        tool: "save_personal_context",
        draft: { entries: [{ content: "导师要求月底交初稿" }] },
      },
    ]);
    // 草案就是草案：上下文表里还没有这一条
    expect(await listMyPersonalContext(student.id)).toEqual([]);
    expect((await listPersonalChatHistory(student.id)).map((m) => m.content)).toEqual([
      "记住我这月底要交初稿",
      "已拟好草案，请确认。",
    ]);
  });

  it("个人 scope 下给无权限的项目，工具照实报错", async () => {
    const { student, project } = await scene();
    const { model } = capturingReplay([
      toolCallStep("list_tasks", { projectId: "00000000-0000-0000-0000-000000000000" }),
      textStep("查不到这个项目。"),
    ]);
    void project;
    const result = await runAgentTurn({
      actorId: student.id,
      userText: "看看那个项目的任务",
      scope: { kind: "personal" },
      model,
    });
    const trace = result.toolTrace as { toolName: string; output: unknown }[];
    expect(trace[0].toolName).toBe("list_tasks");
    // 工具抛错时 AI SDK 走 tool-error 分支，工具轨迹里只有这次调用、没有结果 ——
    // 越权查询在轨迹里留不下任何数据，模型拿到的也只是一句错误（编排本身照常收尾）。
    expect(trace[0].output).toBeUndefined();
    expect(result.text).toBe("查不到这个项目。");
  });
});

// 从捕获到的 prompt 里剥掉 system 段，只留对话消息 —— 用来断言「模型到底看到了哪些上文」。
// 系统提示（军规 + 快照）另有用例盯着，这里只管 messages 那一串。
function chatMessages(prompt: unknown) {
  type Part = { type?: string; text?: string };
  return (prompt as { role: string; content: unknown }[])
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      // AI SDK 交给 provider 时，每条消息的内容都是「部件数组」，纯文本就是单个 text 部件
      content: Array.isArray(m.content)
        ? (m.content as Part[])
            .map((p) => (p.type === "text" ? (p.text ?? "") : `[${p.type}]`))
            .join("")
        : String(m.content),
    }));
}

describe("runAgentTurn（续接上文）", () => {
  beforeEach(resetDb);

  it("第二轮带上前一轮的问与答，助手接得上话", async () => {
    const { student } = await scene();
    await runAgentTurn({
      actorId: student.id,
      userText: "第一问",
      scope: { kind: "personal" },
      model: capturingReplay([textStep("第一答")]).model,
    });

    const { model, prompts } = capturingReplay([textStep("第二答")]);
    await runAgentTurn({
      actorId: student.id,
      userText: "第二问",
      scope: { kind: "personal" },
      model,
    });

    expect(chatMessages(prompts[0])).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
    ]);
  });

  it("只带最近 N 条：第三轮在 limit=2 时看不到第一轮", async () => {
    const { student } = await scene();
    for (const [ask, reply] of [
      ["第一问", "第一答"],
      ["第二问", "第二答"],
    ]) {
      await runAgentTurn({
        actorId: student.id,
        userText: ask,
        scope: { kind: "personal" },
        model: capturingReplay([textStep(reply)]).model,
      });
    }

    await setAiHistoryLimit(student.id, 2);
    const { model, prompts } = capturingReplay([textStep("第三答")]);
    await runAgentTurn({
      actorId: student.id,
      userText: "第三问",
      scope: { kind: "personal" },
      model,
    });

    expect(chatMessages(prompts[0])).toEqual([
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答" },
      { role: "user", content: "第三问" },
    ]);
  });

  it("条数设成 0 → 只带本轮，助手回到从前的「失忆」状态", async () => {
    const { student } = await scene();
    await runAgentTurn({
      actorId: student.id,
      userText: "第一问",
      scope: { kind: "personal" },
      model: capturingReplay([textStep("第一答")]).model,
    });

    await setAiHistoryLimit(student.id, 0);
    const { model, prompts } = capturingReplay([textStep("第二答")]);
    await runAgentTurn({
      actorId: student.id,
      userText: "第二问",
      scope: { kind: "personal" },
      model,
    });

    expect(chatMessages(prompts[0])).toEqual([{ role: "user", content: "第二问" }]);
  });

  it("项目 scope 读的是同一条偏好：项目会话也会带上文", async () => {
    const { student, project } = await scene();
    await runAgentTurn({
      actorId: student.id,
      projectId: project.id,
      userText: "项目第一问",
      model: capturingReplay([textStep("项目第一答")]).model,
    });

    const { model, prompts } = capturingReplay([textStep("项目第二答")]);
    await runAgentTurn({
      actorId: student.id,
      projectId: project.id,
      userText: "项目第二问",
      model,
    });

    expect(chatMessages(prompts[0])).toEqual([
      { role: "user", content: "项目第一问" },
      { role: "assistant", content: "项目第一答" },
      { role: "user", content: "项目第二问" },
    ]);
  });
});
