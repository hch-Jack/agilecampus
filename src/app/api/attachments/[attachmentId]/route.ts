import { z } from "zod";
import { auth } from "@/lib/auth";
import { getAttachmentForDownload } from "@/lib/attachment";
import { AppError, ForbiddenError } from "@/lib/errors";

type Ctx = { params: Promise<{ attachmentId: string }> };

// RFC 5987：中文等非 ASCII 文件名进 Content-Disposition 须编码
function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "未登录" }, { status: 401 });

  const { attachmentId } = await ctx.params;
  if (!z.uuid().safeParse(attachmentId).success)
    return Response.json({ error: "附件不存在" }, { status: 404 });

  try {
    const att = await getAttachmentForDownload(session.user.id, attachmentId);
    // Buffer 不入 BodyInit 类型（TS 5.7 泛型 Uint8Array 亦不兼容 BufferSource），拷一份纯 ArrayBuffer 视图
    const body = Uint8Array.from(att.data);
    return new Response(body, {
      headers: {
        "Content-Type": att.mimeType ?? "application/octet-stream",
        "Content-Length": String(att.size),
        // 恒为 attachment 而非 inline：防 HTML/SVG 借内联渲染 XSS；nosniff 双保险
        "Content-Disposition": contentDisposition(att.filename),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError)
      return Response.json({ error: "没有权限下载该附件" }, { status: 403 });
    if (e instanceof AppError)
      return Response.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
