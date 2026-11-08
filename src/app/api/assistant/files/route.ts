import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { saveAgentFile } from "@/lib/agent/files";
import { deleteBlob, saveBlobFromStream } from "@/lib/blob-store";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { AppError } from "@/lib/errors";

// 助手对话的文件上传。两种姿势：
// - raw body（网页用）：`POST /api/assistant/files?name=…&mime=…`，请求体就是文件字节，
//   服务端流式写盘 —— 1GB 也不进内存；
// - multipart/form-data（旧客户端 / 测试兼容）：字段名 `file`，会整份读进内存，只适合小文件。
// 只允许登录用户、只存到自己名下（ownerId 恒取 session）。
export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const url = new URL(req.url);
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_FILE_SIZE)
    return NextResponse.json({ error: `文件不能超过 ${MAX_FILE_SIZE_LABEL}` }, { status: 413 });

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) return uploadMultipart(req, session.user.id);

  const filename = (url.searchParams.get("name") ?? "").trim().slice(0, 200);
  if (!filename) return NextResponse.json({ error: "缺少文件名" }, { status: 400 });
  // 网页的上传封装统一用 `type`；旧调用方用 `mime`，两个都认
  const mimeType = url.searchParams.get("mime") ?? url.searchParams.get("type") ?? null;

  let blob: { storageKey: string; size: number };
  try {
    blob = await saveBlobFromStream(req.body, MAX_FILE_SIZE);
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 413 });
    throw e;
  }

  try {
    const row = await saveAgentFile(session.user.id, {
      filename,
      mimeType,
      storageKey: blob.storageKey,
    });
    return NextResponse.json({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      url: `/api/assistant/files/${row.id}`,
    });
  } catch (e) {
    await deleteBlob(blob.storageKey);
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/assistant/files] 上传失败:", e);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }
}

async function uploadMultipart(req: Request, userId: string) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "上传格式不对" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "没有选择文件" }, { status: 400 });
  if (file.size > MAX_FILE_SIZE)
    return NextResponse.json({ error: `文件不能超过 ${MAX_FILE_SIZE_LABEL}` }, { status: 413 });
  if (file.size === 0) return NextResponse.json({ error: "不能上传空文件" }, { status: 400 });

  try {
    const data = Buffer.from(await file.arrayBuffer());
    const row = await saveAgentFile(userId, {
      filename: file.name || "未命名文件",
      mimeType: file.type || null,
      data,
    });
    return NextResponse.json({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      url: `/api/assistant/files/${row.id}`,
    });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/assistant/files] 上传失败:", e);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }
}
