import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { deleteAttachment, getAttachmentForDownload } from "@/lib/attachment";
import { attachmentFileResponse } from "@/lib/file-response";
import { AppError, ForbiddenError } from "@/lib/errors";

type Ctx = { params: Promise<{ attachmentId: string }> };

function parseId(raw: string) {
  const r = z.uuid().safeParse(raw);
  return r.success ? r.data : null;
}

/** GET /api/agent/attachments/{attachmentId} — Bearer 下载任务附件。 */
export async function GET(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { attachmentId: raw } = await ctx.params;
  const attachmentId = parseId(raw);
  if (!attachmentId) return NextResponse.json({ error: "附件不存在" }, { status: 404 });

  try {
    const att = await getAttachmentForDownload(userId, attachmentId);
    return attachmentFileResponse(att);
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: "没有权限下载该附件" }, { status: 403 });
    if (e instanceof AppError)
      return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}

/** DELETE /api/agent/attachments/{attachmentId} — 删除任务附件（需任务写权限）。 */
export async function DELETE(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { attachmentId: raw } = await ctx.params;
  const attachmentId = parseId(raw);
  if (!attachmentId) return NextResponse.json({ error: "附件不存在" }, { status: 400 });

  try {
    await deleteAttachment(userId, attachmentId);
    return NextResponse.json({ deleted: attachmentId });
  } catch (e) {
    return mapAgentError(e, "[DELETE /api/agent/attachments/:id]");
  }
}
