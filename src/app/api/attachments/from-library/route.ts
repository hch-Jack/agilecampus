import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { copyLibraryItemToTask } from "@/lib/agent/library";
import { AppError, ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  itemId: z.uuid(),
  taskId: z.uuid(),
});

/**
 * POST /api/attachments/from-library
 * 把资源库文件复制成任务附件（网页「添加附件」菜单的第二条路径）。
 * 读权限、任务写权限与 1GB 上限都在 copyLibraryItemToTask 内部重校。
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "请选择文件和任务" }, { status: 400 });

  try {
    const row = await copyLibraryItemToTask(
      session.user.id,
      parsed.data.itemId,
      parsed.data.taskId,
    );
    return NextResponse.json({ id: row.id, filename: row.filename });
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/attachments/from-library] 失败:", e);
    return NextResponse.json({ error: "添加失败，请重试" }, { status: 500 });
  }
}
