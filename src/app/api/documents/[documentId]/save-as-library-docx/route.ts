import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import { DOCX_EDIT_MAX_BYTES } from "@/lib/documents/format";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { ForbiddenError } from "@/lib/errors";
import { saveDocumentBytesToLibrary } from "@/lib/library/save-as";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function looksLikeZip(bytes: Buffer): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

/**
 * POST /api/documents/[documentId]/save-as-library-docx
 * Query: filename, scope, teamId?, folderId?
 * Body: SuperDoc 导出的 .docx 原始字节。
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
  const filename = (url.searchParams.get("filename") ?? "").trim();
  const scope = url.searchParams.get("scope");
  const teamId = url.searchParams.get("teamId") || undefined;
  const folderId = url.searchParams.get("folderId") || null;

  if (!filename) return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
  if (scope !== "personal" && scope !== "team") {
    return NextResponse.json({ error: "另存目标不正确" }, { status: 400 });
  }
  if (scope === "team" && !teamId) {
    return NextResponse.json({ error: "请选择团队" }, { status: 400 });
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
    if (bytes.length === 0) return NextResponse.json({ error: "不能保存空文件" }, { status: 400 });
    if (bytes.length > DOCX_EDIT_MAX_BYTES) {
      return NextResponse.json({ error: "文档超过在线编辑大小上限" }, { status: 413 });
    }
    if (!looksLikeZip(bytes)) {
      return NextResponse.json({ error: "导出的 Word 文件无法识别" }, { status: 400 });
    }

    const result = await saveDocumentBytesToLibrary({
      documentId,
      userId: session.user.id,
      filename,
      scope,
      teamId,
      folderId,
      bytes,
      mimeType: DOCX_MIME,
    });
    return NextResponse.json({ ...result, savedToLibrary: true });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
