import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { restoreDocumentVersion } from "@/lib/documents/service";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ documentId: string }> };

const bodySchema = z.object({
  version: z.number().int().min(1),
  sessionId: z.string().min(8).max(80),
});

/** POST /api/documents/[documentId]/restore —— 把历史版本恢复为新的当前版本 */
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
  if (!parsed.success) return NextResponse.json({ error: "恢复参数不正确" }, { status: 400 });

  try {
    const result = await restoreDocumentVersion({
      documentId,
      userId: session.user.id,
      sessionId: parsed.data.sessionId,
      version: parsed.data.version,
    });
    return NextResponse.json(result);
  } catch (e) {
    return documentErrorResponse(e);
  }
}
