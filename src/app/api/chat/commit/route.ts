import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { commitDraft, commitPersonalDraft } from "@/lib/agent/commit";
import { COMMIT_TOOL_NAMES, WRITE_TOOL_NAMES } from "@/lib/agent/tools";
import { AppError, ForbiddenError } from "@/lib/errors";

// scope 与 /api/chat 对齐：project 落库要 projectId（身份仍取自 session），
// personal 的 projectId 由模型填在草案里、由 commitPersonalDraft 拆出来重校。
const schema = z.object({
  scope: z.enum(["project", "personal"]).default("project"),
  projectId: z.uuid().optional(),
  tool: z.enum(COMMIT_TOOL_NAMES),
  draft: z.unknown(),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const { scope, projectId, tool, draft } = parsed.data;
  if (scope === "project" && (!projectId || !WRITE_TOOL_NAMES.includes(tool as never))) {
    // 项目页只认 WRITE_TOOL_NAMES 里的写工具，个人上下文不经项目页落库
    return NextResponse.json({ error: "草案格式无效" }, { status: 400 });
  }

  try {
    const result =
      scope === "personal"
        ? await commitPersonalDraft(session.user.id, tool, draft)
        : await commitDraft(session.user.id, projectId!, tool as (typeof WRITE_TOOL_NAMES)[number], draft);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ForbiddenError) return NextResponse.json({ error: "没有权限" }, { status: 403 });
    // 带上出问题的字段：草案里少一个 id、或某个字段形状不对，都落到这一句上。
    // 只说「草案格式无效」的话，报错点在落库、病因却在拟稿，用户与后来人都无从下手。
    if (e instanceof z.ZodError) {
      const issue = e.issues[0];
      const where = issue?.path.join(".") || "载荷";
      return NextResponse.json({ error: `草案格式无效（${where}）：${issue?.message ?? ""}`.trim() }, { status: 400 });
    }
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/chat/commit] 落库失败:", e);
    return NextResponse.json({ error: "落库失败，请重试" }, { status: 500 });
  }
}
