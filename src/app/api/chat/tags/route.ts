import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listMessageTags, listMessagesByTag } from "@/lib/agent/message-tags";
import { chatErrorResponse } from "@/lib/agent/chat-http";
import { normalizeMessageTag } from "@/lib/message-tag";

/**
 * 我的助手消息标签。
 *
 * - `GET /api/chat/tags` → 全部标签与次数，供面板分组；
 * - `GET /api/chat/tags?tag=进度` → 该标签下的历史消息（最近的在前）。
 *
 * 只读本人数据；标签按用户隔离，别人给同一条消息打的标签不会出现在这里。
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  try {
    const raw = new URL(req.url).searchParams.get("tag");
    if (raw !== null) {
      const tag = normalizeMessageTag(raw);
      if (!tag) return NextResponse.json({ tag: null, messages: [] });
      const messages = await listMessagesByTag(session.user.id, tag);
      return NextResponse.json({ tag, messages });
    }
    const tags = await listMessageTags(session.user.id);
    return NextResponse.json({ tags });
  } catch (e) {
    return chatErrorResponse(e, "[GET /api/chat/tags]");
  }
}
