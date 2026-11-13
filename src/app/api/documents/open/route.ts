import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { documentErrorResponse } from "@/lib/documents/http";
import { ensureDocument } from "@/lib/documents/service";

export const runtime = "nodejs";

const inputSchema = z.object({
  sourceType: z.string().min(1).max(60),
  sourceId: z.string().min(1).max(120),
});

/** POST /api/documents/open —— 按来源打开/懒创建文档，返回 documentId */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "参数不正确" }, { status: 400 });

  try {
    const access = await ensureDocument(
      session.user.id,
      parsed.data.sourceType,
      parsed.data.sourceId,
    );
    return NextResponse.json({
      documentId: access.document.id,
      format: access.document.format,
      canEdit: access.canEdit,
    });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
