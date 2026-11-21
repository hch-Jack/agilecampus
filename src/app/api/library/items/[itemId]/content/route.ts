import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { attachmentFileResponse } from "@/lib/file-response";
import { getLibraryItemAccess } from "@/lib/library/access";
import { getLibraryFileRef } from "@/lib/library/content";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/library/items/[itemId]/content?version=N：当前/历史版本原始字节 */
export async function GET(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { itemId } = await ctx.params;
  if (!z.uuid().safeParse(itemId).success) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
  const access = await getLibraryItemAccess(session.user.id, itemId);
  if (!access) return NextResponse.json({ error: "文件不存在" }, { status: 404 });

  const raw = new URL(req.url).searchParams.get("version");
  const version = raw ? Number(raw) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    return NextResponse.json({ error: "版本号不正确" }, { status: 400 });
  }

  try {
    const ref = await getLibraryFileRef(session.user.id, itemId, version);
    const res = attachmentFileResponse({
      filename: ref.filename,
      mimeType: ref.mimeType,
      size: ref.size,
      storageKey: ref.storageKey,
    });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Library-Version", String(ref.version));
    return res;
  } catch {
    return NextResponse.json({ error: "版本不存在" }, { status: 404 });
  }
}
