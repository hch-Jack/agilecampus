import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { stageDmAttachment } from "@/lib/dm";
import { deleteBlob, saveBlobFromStream } from "@/lib/blob-store";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { AppError } from "@/lib/errors";

// 私信/群聊附件的**预上传**：先把字节落盘、落一行 dm_attachments（还没有消息引用），
// 客户端拿到 id 后再调 sendMessageAction / sendGroupMessageAction 挂到消息上。
// 这样大文件不经过 server action；未发送的孤儿行不会被任何会话列出。
export const runtime = "nodejs";

/**
 * POST /api/dm/attachments/upload?name=<文件名>&type=<mime>
 * Body: 文件原始字节。返回 { id, filename, size }。
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const url = new URL(req.url);
  const filename = (url.searchParams.get("name") ?? "").trim().slice(0, 200);
  if (!filename) return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
  const mimeType = url.searchParams.get("type") || null;

  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE)
    return NextResponse.json({ error: `文件不能超过 ${MAX_FILE_SIZE_LABEL}` }, { status: 413 });

  let blob: { storageKey: string; size: number };
  try {
    blob = await saveBlobFromStream(req.body, MAX_FILE_SIZE);
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 413 });
    throw e;
  }

  try {
    const att = await stageDmAttachment(session.user.id, {
      filename,
      mimeType,
      storageKey: blob.storageKey,
    });
    return NextResponse.json(att);
  } catch (e) {
    await deleteBlob(blob.storageKey);
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/dm/attachments/upload] 上传失败:", e);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }
}
