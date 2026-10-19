import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { applyTaskSuccessorDelta } from "@/lib/task";

type Ctx = { params: Promise<{ taskId: string }> };

const bodySchema = z.object({
  add: z.array(z.uuid()).optional(),
  remove: z.array(z.uuid()).optional(),
});

// CC 写入：增量增删某任务的**后置任务**（路径 id 是前置任务）。
// 增量而非全量：模型只需说出要加/要删的边，不会因漏列旧边而误删。
// 后置须与前置同级；跨层级历史边只读（remove 它会明确报错，而不是静默无效）。
export async function POST(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { taskId: raw } = await ctx.params;
  const parsedId = z.uuid().safeParse(raw);
  if (!parsedId.success) return NextResponse.json({ error: "taskId 无效" }, { status: 400 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    const r = await applyTaskSuccessorDelta(userId, parsedId.data, parsed.data);
    return NextResponse.json(r);
  } catch (e) {
    return mapAgentError(e, "[POST /api/agent/tasks/:id/successors]");
  }
}
