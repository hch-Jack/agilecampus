import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  autoCategorizePersonalConversations,
  listPersonalConversations,
  toAssistantConversationSummary,
} from "@/lib/agent/conversation";
import { chatErrorResponse } from "@/lib/agent/chat-http";

/**
 * 「自动归类」：给还没分类的个人会话按关键词归类，返回最新列表。
 *
 * 只补**空分类**，用户手动改过的一律不动；命中不了关键词的会话继续保持未分类。
 * 身份只取 session。
 */
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  try {
    const updated = await autoCategorizePersonalConversations(session.user.id);
    const conversations = await listPersonalConversations(session.user.id);
    return NextResponse.json({
      updated,
      conversations: conversations.map(toAssistantConversationSummary),
    });
  } catch (e) {
    return chatErrorResponse(e, "[POST /api/chat/conversations/categorize]");
  }
}
