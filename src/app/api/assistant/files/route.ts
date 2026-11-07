import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { saveAgentFile } from "@/lib/agent/files";
import { ATTACHMENT_MAX_SIZE } from "@/lib/attachment";
import { AppError } from "@/lib/errors";

// 助手对话的文件上传：multipart/form-data，字段名 `file`。
// 只允许登录用户、只存到自己名下（ownerId 恒取 session）；10MB 上限与任务附件一致。
// 上传成功返回元数据 + 下载地址，客户端据此渲染文件胶囊；发送时只回传 id。
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "上传格式不对" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "没有选择文件" }, { status: 400 });
  if (file.size > ATTACHMENT_MAX_SIZE)
    return NextResponse.json({ error: "文件不能超过 10MB" }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "不能上传空文件" }, { status: 400 });

  try {
    const data = Buffer.from(await file.arrayBuffer());
    const row = await saveAgentFile(session.user.id, {
      filename: file.name || "未命名文件",
      mimeType: file.type || null,
      size: data.length,
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
