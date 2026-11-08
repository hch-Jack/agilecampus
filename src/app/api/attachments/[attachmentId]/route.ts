import { z } from "zod";
import { auth } from "@/lib/auth";
import { getAttachmentForDownload } from "@/lib/attachment";
import { attachmentFileResponse } from "@/lib/file-response";
import { AppError, ForbiddenError } from "@/lib/errors";

type Ctx = { params: Promise<{ attachmentId: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "未登录" }, { status: 401 });

  const { attachmentId } = await ctx.params;
  if (!z.uuid().safeParse(attachmentId).success)
    return Response.json({ error: "附件不存在" }, { status: 404 });

  try {
    const att = await getAttachmentForDownload(session.user.id, attachmentId);
    // 磁盘上的大文件流式返回；历史附件从 data 列返回（同一套安全头）
    return attachmentFileResponse(att);
  } catch (e) {
    if (e instanceof ForbiddenError)
      return Response.json({ error: "没有权限下载该附件" }, { status: 403 });
    if (e instanceof AppError)
      return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
