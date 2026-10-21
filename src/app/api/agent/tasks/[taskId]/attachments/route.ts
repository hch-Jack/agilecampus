import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { listAttachments } from "@/lib/attachment";

type Ctx = { params: Promise<{ taskId: string }> };

/** GET /api/agent/tasks/{taskId}/attachments — 列任务附件（所有项目成员可读）。 */
export async function GET(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { taskId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "taskId 无效" }, { status: 400 });

  try {
    const rows = await listAttachments(userId, parsed.data);
    return NextResponse.json({
      taskId: parsed.data,
      attachments: rows.map((a) => ({
        id: a.id,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
        createdAt: a.createdAt,
        uploaderName: a.uploaderName,
      })),
    });
  } catch (e) {
    return mapAgentError(e, "[GET /api/agent/tasks/:id/attachments]");
  }
}
