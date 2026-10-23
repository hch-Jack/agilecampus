import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  startPersonalConversation,
  toAssistantConversationSummary,
} from "@/lib/agent/conversation";
import { chatErrorResponse } from "@/lib/agent/chat-http";

/**
 * 「新对话」：建一条空的个人会话。
 *
 * 最近一条如果本来就是空的就复用它（见 `startPersonalConversation`），
 * 所以连点「新对话」不会堆出一串空会话。身份只取 session。
 */
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  try {
    const conv = await startPersonalConversation(session.user.id);
    return NextResponse.json({
      conversation: toAssistantConversationSummary(conv),
    });
  } catch (e) {
    return chatErrorResponse(e, "[POST /api/chat/conversations]");
  }
}
