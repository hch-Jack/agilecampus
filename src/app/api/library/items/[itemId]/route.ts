import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getLibraryItemAccess } from "@/lib/library/access";
import { getItemDetail } from "@/lib/library/versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/library/items/[itemId]：预览窗右侧版本/日志/权限数据 */
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { itemId } = await ctx.params;
  if (!z.uuid().safeParse(itemId).success) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
  const access = await getLibraryItemAccess(session.user.id, itemId);
  if (!access) return NextResponse.json({ error: "文件不存在" }, { status: 404 });

  const detail = await getItemDetail(session.user.id, itemId);
  return NextResponse.json({
    item: detail.item,
    library: {
      id: detail.library.id,
      kind: detail.library.kind,
      teamId: detail.library.teamId,
    },
    permissions: {
      canView: detail.access.canView,
      canEdit: detail.access.canEdit,
      canManage: detail.access.canManage,
      role: detail.access.role,
    },
    versions: detail.versions,
    operations: detail.operations,
    links: detail.links,
    contentUrl: detail.contentUrl,
  });
}
