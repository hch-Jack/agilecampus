import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listGeneratedFiles } from "@/lib/agent/conversation";
import { chatErrorResponse } from "@/lib/agent/chat-http";

/**
 * `GET /api/chat/files` → 我在助手面板里生成过的全部文件（最近的在前）。
 *
 * 只读本人数据：从个人会话里助手消息的工具轨迹还原 `create_file` 的结果，
 * 文件名/类型/大小随行返回，下载走 `/api/assistant/files/<id>`（同一套本人校验）。
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  try {
    const files = await listGeneratedFiles(session.user.id);
    return NextResponse.json({ files });
  } catch (e) {
    return chatErrorResponse(e, "[GET /api/chat/files]");
  }
}
