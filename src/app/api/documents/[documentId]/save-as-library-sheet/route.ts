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
import { ForbiddenError } from "@/lib/errors";
import { saveDocumentBytesToLibrary } from "@/lib/library/save-as";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const MIME_BY_BOOK: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  csv: "text/csv; charset=utf-8",
};

/**
 * POST /api/documents/[documentId]/save-as-library-sheet
 * Query: filename, scope, teamId?, folderId?
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
  const filename = (url.searchParams.get("filename") ?? "").trim();
  const scope = url.searchParams.get("scope");
  const teamId = url.searchParams.get("teamId") || undefined;
  // 缺省 = 默认「手动上传」；root = 资源库根目录
  const folderParam = url.searchParams.get("folderId");
  const folderId: string | null | undefined =
    folderParam === null ? undefined : folderParam === "root" ? null : folderParam;
  if (folderId && !z.uuid().safeParse(folderId).success) {
    return NextResponse.json({ error: "目标文件夹不正确" }, { status: 400 });
  }

  if (!filename) return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
  if (scope !== "personal" && scope !== "team") {
    return NextResponse.json({ error: "另存目标不正确" }, { status: 400 });
  }
  if (scope === "team" && !teamId) {
    return NextResponse.json({ error: "请选择团队" }, { status: 400 });
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

    const bookType = sheetBookTypeOf(filename);
    if (!bookType) return NextResponse.json({ error: "表格格式不支持" }, { status: 400 });

    const result = await saveDocumentBytesToLibrary({
      documentId,
      userId: session.user.id,
      filename,
      scope,
      teamId,
      folderId,
      bytes,
      mimeType: MIME_BY_BOOK[bookType] ?? null,
    });
    return NextResponse.json({ ...result, savedToLibrary: true });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
