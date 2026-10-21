import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { runAgentTurn } from "@/lib/agent/orchestrator";
import { collectDraftOptions } from "@/lib/agent/draft-options";
import { AppError, ForbiddenError } from "@/lib/errors";

// scope 决定这轮对话挂在哪儿：project 走项目共享会话（要 projectId），personal 走每人的私人会话。
// personal 也可以带 projectId：它**不改变会话归属**，只是「用户此刻在看哪个项目」（焦点），
// 让这一轮多带项目快照与项目专属工具。权限在编排入口按 getProjectForUser 校。
// 身份一律取自 session —— 请求体里没有、也不接受 actorId 之类的字段。
const schema = z.object({
  scope: z.enum(["project", "personal"]).default("project"),
  projectId: z.uuid().optional(),
  userText: z.string().trim().min(1, "请输入内容"),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { scope, projectId, userText } = parsed.data;
  if (scope === "project" && !projectId) {
    return NextResponse.json({ error: "缺少项目 id" }, { status: 400 });
  }

  try {
    const result =
      scope === "personal"
        ? await runAgentTurn({
            actorId: session.user.id,
            userText,
            scope: { kind: "personal", focusProjectId: projectId },
          })
        : await runAgentTurn({ actorId: session.user.id, userText, projectId: projectId! });

    // 个人 scope 的草案可能指向多个项目，下拉选项随响应一并给（见 lib/agent/draft-options.ts）
    const options =
      scope === "personal" ? await collectDraftOptions(session.user.id, result.drafts) : undefined;

    return NextResponse.json({
      text: result.text,
      toolTrace: result.toolTrace,
      drafts: result.drafts,
      ...(options ? { options } : {}),
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: "没有权限" }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    // 未预期错误（含 DeepSeek 超时/失败）：服务端留痕，对客户端只呈通用消息，不暴露内部细节
    console.error("[/api/chat] runAgentTurn 失败:", e);
    return NextResponse.json({ error: "对话失败，请重试" }, { status: 500 });
  }
}
