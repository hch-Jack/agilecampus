import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AppError, ForbiddenError } from "@/lib/errors";
import { copyLibraryItemToAgentFile } from "@/lib/agent/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  itemId: z.uuid(),
});

/**
 * POST /api/assistant/files/from-library
 * 面板「从资源库选择附件」：把当前用户有权读的资源库文件登记成一份 assistant 文件，
 * 之后就能像随消息上传的文件一样交给模型读、转发、存进任务。
 *
 * 不复制字节：agent_files 与 library_versions 共用同一个 storageKey，
 * 删除任一边都会先做引用检查（见 documents/blobs.ts 的 blobIsReferenced）。
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请选择一个资源库文件" }, { status: 400 });

  try {
    const row = await copyLibraryItemToAgentFile(session.user.id, parsed.data.itemId);
    return NextResponse.json({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      url: `/api/assistant/files/${row.id}`,
    });
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/assistant/files/from-library] 失败:", e);
    return NextResponse.json({ error: "无法从资源库添加文件，请重试" }, { status: 500 });
  }
}
