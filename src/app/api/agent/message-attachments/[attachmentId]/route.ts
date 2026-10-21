import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized } from "@/lib/agent-auth";
import { getDmAttachmentForDownload } from "@/lib/dm";
import { attachmentFileResponse } from "@/lib/file-response";
import { AppError, ForbiddenError } from "@/lib/errors";

type Ctx = { params: Promise<{ attachmentId: string }> };

/**
 * GET /api/agent/message-attachments/{attachmentId} — Bearer 下载私信/群聊附件。
 * 权限口径与网页下载一致：私信收发双方、群聊成员。
 */
export async function GET(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { attachmentId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "附件不存在" }, { status: 404 });

  try {
    const att = await getDmAttachmentForDownload(userId, parsed.data);
    return attachmentFileResponse(att);
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: "没有权限下载该附件" }, { status: 403 });
    if (e instanceof AppError)
      return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
