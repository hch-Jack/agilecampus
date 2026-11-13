import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import {
  SHEET_EDIT_MAX_BYTES,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SHEET_MAX_SHEETS,
  sheetBookTypeOf,
} from "@/lib/documents/format";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { saveDocument, saveDocumentAs } from "@/lib/documents/service";
import { ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const MIME_BY_BOOK: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
};

/**
 * POST /api/documents/[documentId]/save-sheet
 * Query: baseVersion, sessionId, force?, asName?
 * Body: xlsx/xls/csv 原始字节。
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
  if (Number.isFinite(declared) && declared > SHEET_EDIT_MAX_BYTES + 1024) {
    return NextResponse.json({ error: "表格超过在线编辑大小上限" }, { status: 413 });
  }

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");
    if (access.document.format !== "sheet") {
      return NextResponse.json({ error: "该文档不是表格格式" }, { status: 400 });
    }

    const bytes = Buffer.from(await req.arrayBuffer());
    if (bytes.length === 0) return NextResponse.json({ error: "不能保存空文件" }, { status: 400 });
    if (bytes.length > SHEET_EDIT_MAX_BYTES) {
      return NextResponse.json({ error: "表格超过在线编辑大小上限" }, { status: 413 });
    }

    // 服务端再解析一次：确认字节确实是我们支持的表格，并守住规模上限
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(bytes, { type: "buffer" });
    } catch {
      return NextResponse.json({ error: "表格文件无法解析" }, { status: 400 });
    }
    if (workbook.SheetNames.length > SHEET_MAX_SHEETS) {
      return NextResponse.json({ error: `最多支持 ${SHEET_MAX_SHEETS} 个工作表` }, { status: 413 });
    }
    for (const name of workbook.SheetNames) {
      const ws = workbook.Sheets[name];
      if (!ws?.["!ref"]) continue;
      const range = XLSX.utils.decode_range(ws["!ref"]);
      if (
        range.e.r - range.s.r + 1 > SHEET_MAX_ROWS ||
        range.e.c - range.s.c + 1 > SHEET_MAX_COLS
      ) {
        return NextResponse.json(
          { error: `单个工作表最多 ${SHEET_MAX_ROWS} 行 × ${SHEET_MAX_COLS} 列` },
          { status: 413 },
        );
      }
    }

    const bookType = sheetBookTypeOf(asName ?? access.document.filename);
    if (!bookType) return NextResponse.json({ error: "表格格式不支持" }, { status: 400 });
    const mimeType = MIME_BY_BOOK[bookType] ?? null;

    if (asName) {
      const result = await saveDocumentAs({
        documentId,
        userId: session.user.id,
        newFilename: asName,
        bytes,
        mimeType,
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
      mimeType,
      note,
    });
    return NextResponse.json(result);
  } catch (e) {
    return documentErrorResponse(e);
  }
}
