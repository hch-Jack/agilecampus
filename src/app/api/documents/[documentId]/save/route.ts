import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import { exportTiptapToDocx } from "@/lib/documents/docx-export";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { maxBytesForFormat, saveDocument, saveDocumentAs } from "@/lib/documents/service";
import { parseTiptapDoc } from "@/lib/documents/tiptap";
import { ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const contentSchema = z.union([
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tiptap"), doc: z.unknown() }),
]);

const bodySchema = z.object({
  baseVersion: z.number().int().min(1),
  sessionId: z.string().min(8).max(80),
  force: z.boolean().optional(),
  saveAsName: z.string().min(1).max(200).optional(),
  note: z.enum(["autosave", "manual", "restore"]).optional(),
  content: contentSchema,
});

/**
 * POST /api/documents/[documentId]/save
 * 文本/Markdown/代码/HTML 与 docx 富文本的保存与另存为。
 * 表格二进制走 /save-sheet。
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

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "保存参数不正确" }, { status: 400 });

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");

    const maxBytes = maxBytesForFormat(access.document.format);
    const { content } = parsed.data;
    let bytes: Buffer;
    let mimeType: string | null;
    let editorState: unknown = undefined;

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
      const doc = parseTiptapDoc(content.doc);
      bytes = await exportTiptapToDocx(doc);
      mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      editorState = doc;
    }

    if (bytes.length > maxBytes) {
      return NextResponse.json({ error: "文档超过在线编辑大小上限" }, { status: 413 });
    }

    if (parsed.data.saveAsName) {
      const result = await saveDocumentAs({
        documentId,
        userId: session.user.id,
        newFilename: parsed.data.saveAsName,
        bytes,
        mimeType,
        editorState,
      });
      return NextResponse.json({ ...result, savedAs: true });
    }

    const result = await saveDocument({
      documentId,
      userId: session.user.id,
      sessionId: parsed.data.sessionId,
      baseVersion: parsed.data.baseVersion,
      force: parsed.data.force,
      bytes,
      mimeType,
      editorState,
      note: parsed.data.note ?? "manual",
    });
    return NextResponse.json(result);
  } catch (e) {
    return documentErrorResponse(e);
  }
}
