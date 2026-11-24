import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import { DOCX_EDIT_MAX_BYTES, isSameEditableFormat } from "@/lib/documents/format";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { ForbiddenError } from "@/lib/errors";
import { attachmentFileResponse } from "@/lib/file-response";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

function defaultCopyName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}-编辑副本`;
  return `${filename.slice(0, dot)}-编辑副本${filename.slice(dot)}`;
}

/**
 * POST /api/documents/[documentId]/export-docx?filename=...
 * Body: SuperDoc 导出的 .docx 原始字节；只回文件，不写库。
 */
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

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");
    if (access.document.format !== "docx") {
      return NextResponse.json({ error: "该文档不是 Word 格式" }, { status: 400 });
    }

    const rawName = new URL(req.url).searchParams.get("filename")?.trim() || "";
    const filename = rawName.replace(/[\\/]/g, "") || defaultCopyName(access.document.filename);
    if (!isSameEditableFormat(access.document.filename, filename, "docx")) {
      return NextResponse.json({ error: "导出文件名扩展名不正确" }, { status: 400 });
    }

    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0) return NextResponse.json({ error: "不能导出空文档" }, { status: 400 });
    if (bytes.length > DOCX_EDIT_MAX_BYTES) {
      return NextResponse.json({ error: "文档超过在线编辑大小上限" }, { status: 413 });
    }
    if (!looksLikeZip(bytes)) {
      return NextResponse.json({ error: "导出的 Word 文件无法识别" }, { status: 400 });
    }

    const res = attachmentFileResponse({
      filename,
      mimeType: DOCX_MIME,
      size: bytes.length,
      data: bytes,
    });
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (e) {
    return documentErrorResponse(e);
  }
}
