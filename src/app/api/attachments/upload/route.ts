import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { assertCanUploadAttachment, uploadAttachment } from "@/lib/attachment";
import { deleteBlob, saveBlobFromStream } from "@/lib/blob-store";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { AppError, ForbiddenError } from "@/lib/errors";

// 任务附件上传：raw body = 文件字节，元数据走 query。
// 走 route handler 而不是 server action，因为 server action 的 body 上限只有 12MB；
// 这里把请求体直接流式写盘，1GB 也不会整份进内存。
export const runtime = "nodejs";

/**
 * POST /api/attachments/upload?taskId=<uuid>&name=<文件名>&type=<mime>
 * Body: 文件原始字节。返回 { id, filename, size }。
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const url = new URL(req.url);
  const taskId = url.searchParams.get("taskId") ?? "";
  if (!z.uuid().safeParse(taskId).success)
    return NextResponse.json({ error: "任务不存在" }, { status: 404 });

  const filename = (url.searchParams.get("name") ?? "").trim().slice(0, 200);
  if (!filename) return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
  const mimeType = url.searchParams.get("type") || null;

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE)
    return NextResponse.json({ error: `附件不能超过 ${MAX_FILE_SIZE_LABEL}` }, { status: 413 });

  // 先校写权限：无权的人不必把 1GB 传完才收到 403
  try {
    await assertCanUploadAttachment(session.user.id, taskId);
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: "没有权限上传附件" }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }

  let blob: { storageKey: string; size: number };
  try {
    blob = await saveBlobFromStream(req.body, MAX_FILE_SIZE);
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 413 });
    throw e;
  }

  try {
    const row = await uploadAttachment(session.user.id, taskId, {
      filename,
      mimeType,
      storageKey: blob.storageKey,
    });
    return NextResponse.json({ id: row.id, filename, size: blob.size });
  } catch (e) {
    await deleteBlob(blob.storageKey);
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: "没有权限上传附件" }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/attachments/upload] 上传失败:", e);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }
}
