import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { exportTiptapToDocx } from "@/lib/documents/docx-export";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { parseTiptapDoc } from "@/lib/documents/tiptap";
import { getDocumentAccess } from "@/lib/documents/access";
import { ForbiddenError } from "@/lib/errors";
import { saveDocumentBytesToLibrary } from "@/lib/library/save-as";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const contentSchema = z.union([
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("tiptap"), doc: z.unknown() }),
]);

const bodySchema = z.object({
  filename: z.string().min(1).max(200),
  scope: z.enum(["personal", "team"]),
  teamId: z.uuid().optional(),
  folderId: z.uuid().nullable().optional(),
  content: contentSchema,
});

/** POST /api/documents/[documentId]/save-as-library：文本/docx 另存为资源库文件 */
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
  if (!parsed.success) {
    return NextResponse.json({ error: "另存参数不正确" }, { status: 400 });
  }

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");

    const { content } = parsed.data;
    let bytes: Buffer;
    let mimeType: string | null;
    let editorState: unknown;

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
      editorState = parseTiptapDoc(content.doc);
      bytes = await exportTiptapToDocx(
        parseTiptapDoc(content.doc),
      );
      mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }

    const result = await saveDocumentBytesToLibrary({
      documentId,
      userId: session.user.id,
      filename: parsed.data.filename,
      scope: parsed.data.scope,
      teamId: parsed.data.teamId,
      folderId: parsed.data.folderId ?? null,
      bytes,
      mimeType,
      editorState,
    });
    return NextResponse.json({ ...result, savedToLibrary: true });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
