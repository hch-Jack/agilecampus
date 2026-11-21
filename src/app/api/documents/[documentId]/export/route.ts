import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import { exportTiptapToDocx } from "@/lib/documents/docx-export";
import { isSameEditableFormat } from "@/lib/documents/format";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { parseTiptapDoc } from "@/lib/documents/tiptap";
import { ForbiddenError } from "@/lib/errors";
import { attachmentFileResponse } from "@/lib/file-response";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const bodySchema = z.object({
  filename: z.string().min(1).max(200).optional(),
  content: z.union([
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({ kind: z.literal("tiptap"), doc: z.unknown() }),
  ]),
});

function defaultCopyName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}-编辑副本`;
  return `${filename.slice(0, dot)}-编辑副本${filename.slice(dot)}`;
}

/** POST /api/documents/[documentId]/export：把未保存的编辑内容作为文件下载，不写库 */
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    assertSameOrigin(req);
  } catch (e) {
    return documentErrorResponse(e);
  }

  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "导出参数不正确" }, { status: 400 });

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");

    const filename = parsed.data.filename
      ? parsed.data.filename.trim().replace(/[\\/]/g, "")
      : defaultCopyName(access.document.filename);
    if (!isSameEditableFormat(access.document.filename, filename, access.document.format)) {
      return NextResponse.json({ error: "导出文件名扩展名不正确" }, { status: 400 });
    }

    const { content } = parsed.data;
    let bytes: Buffer;
    let mimeType: string | null;
    if (content.kind === "text") {
      if (access.document.format !== "text") {
        return NextResponse.json({ error: "该文档不是文本格式" }, { status: 400 });
      }
      bytes = Buffer.from(content.text, "utf8");
      mimeType = access.document.mimeType ?? "text/plain; charset=utf-8";
    } else {
      if (access.document.format !== "docx") {
        return NextResponse.json({ error: "该文档不是 Word 格式" }, { status: 400 });
      }
      bytes = await exportTiptapToDocx(parseTiptapDoc(content.doc));
      mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }

    const res = attachmentFileResponse({
      filename,
      mimeType,
      size: bytes.length,
      data: bytes,
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    return documentErrorResponse(e);
  }
}
