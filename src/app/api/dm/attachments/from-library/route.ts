import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { stageDmAttachment } from "@/lib/dm";
import { getLibraryFileRef } from "@/lib/library/content";
import { AppError, ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({ itemId: z.uuid() });

/**
 * POST /api/dm/attachments/from-library
 * 把资源库文件预上传成私信/群聊附件（网页发送框「添加附件」菜单的第二条路径）。
 * 只建一行未被消息引用的 dm_attachments；发送 action 会认领它。
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请选择一个资源库文件" }, { status: 400 });

  try {
    // 读权限由 getLibraryFileRef 校；blob 会复制一份进 dm_attachments
    const ref = await getLibraryFileRef(session.user.id, parsed.data.itemId);
    const att = await stageDmAttachment(session.user.id, {
      filename: ref.filename,
      mimeType: ref.mimeType,
      size: ref.size,
      storageKey: ref.storageKey,
    });
    return NextResponse.json(att);
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/dm/attachments/from-library] 失败:", e);
    return NextResponse.json({ error: "添加失败，请重试" }, { status: 500 });
  }
}
