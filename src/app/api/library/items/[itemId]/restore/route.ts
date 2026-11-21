import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { documentErrorResponse } from "@/lib/documents/http";
import { getLibraryItemAccess } from "@/lib/library/access";
import { restoreLibraryVersion } from "@/lib/library/restore";
import { AppError, ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ itemId: string }> };

const bodySchema = z.object({
  version: z.number().int().min(1),
});

/** POST /api/library/items/[itemId]/restore：预览窗恢复历史版本（无需编辑器会话） */
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { itemId } = await ctx.params;
  if (!z.uuid().safeParse(itemId).success) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
  const access = await getLibraryItemAccess(session.user.id, itemId);
  if (!access) return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  if (!access.canEdit) return NextResponse.json({ error: "你没有编辑权限" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "版本号不正确" }, { status: 400 });

  try {
    const result = await restoreLibraryVersion({
      itemId,
      userId: session.user.id,
      version: parsed.data.version,
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    if (e instanceof AppError && !(e as { reason?: string }).reason) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return documentErrorResponse(e);
  }
}
