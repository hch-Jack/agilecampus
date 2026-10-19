import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { listProjectDependenciesDetailed } from "@/lib/task";

type Ctx = { params: Promise<{ projectId: string }> };

// CC 读取：项目内的依赖边（关系图 / 流程图的数据源），带两端标题、状态与是否跨层级。
export async function GET(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { projectId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "projectId 无效" }, { status: 400 });

  try {
    const dependencies = await listProjectDependenciesDetailed(userId, parsed.data);
    return NextResponse.json({ projectId: parsed.data, dependencies });
  } catch (e) {
    return mapAgentError(e, "[GET /api/agent/projects/:id/dependencies]");
  }
}
