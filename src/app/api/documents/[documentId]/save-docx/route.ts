import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import { DOCX_EDIT_MAX_BYTES } from "@/lib/documents/format";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { saveDocument, saveDocumentAs } from "@/lib/documents/service";
import { ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** 简单校验 ZIP 头（.docx 本质是 zip），挡住误传的其它字节 */
function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * POST /api/documents/[documentId]/save-docx
 * Query: baseVersion, sessionId, force?, asName?
 * Body: SuperDoc 导出的 .docx 原始字节。省掉 HTML → docx 重建，保留原排版。
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

  const url = new URL(req.url);
  const baseVersion = Number(url.searchParams.get("baseVersion"));
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const force = url.searchParams.get("force") === "1";
  const asName = url.searchParams.get("asName")?.trim() || null;
  const noteRaw = url.searchParams.get("note");
  const note = noteRaw === "autosave" || noteRaw === "restore" ? noteRaw : "manual";

  if (!Number.isInteger(baseVersion) || baseVersion < 1) {
    return NextResponse.json({ error: "版本号不正确" }, { status: 400 });
  }
  if (sessionId.length < 8 || sessionId.length > 80) {
    return NextResponse.json({ error: "会话标识不正确" }, { status: 400 });
  }

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > DOCX_EDIT_MAX_BYTES + 1024) {
    return NextResponse.json({ error: "文档超过在线编辑大小上限" }, { status: 413 });
  }

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");
    if (access.document.format !== "docx") {
      return NextResponse.json({ error: "该文档不是 Word 格式" }, { status: 400 });
    }

    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0) return NextResponse.json({ error: "不能保存空文档" }, { status: 400 });
    if (bytes.length > DOCX_EDIT_MAX_BYTES) {
      return NextResponse.json({ error: "文档超过在线编辑大小上限" }, { status: 413 });
    }
    if (!looksLikeZip(bytes)) {
      return NextResponse.json({ error: "导出的 Word 文件无法识别" }, { status: 400 });
    }

    if (asName) {
      const result = await saveDocumentAs({
        documentId,
        userId: session.user.id,
        newFilename: asName,
        bytes,
        mimeType: DOCX_MIME,
      });
      return NextResponse.json({ ...result, savedAs: true });
    }

    const result = await saveDocument({
      documentId,
      userId: session.user.id,
      sessionId,
      baseVersion,
      force,
      bytes,
      mimeType: DOCX_MIME,
      note,
    });
    return NextResponse.json(result);
  } catch (e) {
    return documentErrorResponse(e);
  }
}
