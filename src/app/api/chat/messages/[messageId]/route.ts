import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { deleteChatMessage } from "@/lib/agent/conversation";
import { chatErrorResponse } from "@/lib/agent/chat-http";

type Ctx = { params: Promise<{ messageId: string }> };

/**
 * 删除一条消息 = 删除它所在的那一轮（提问 + 回答）。
 *
 * 只允许本人的个人会话；项目共享会话的消息对任何人都不走这个入口，
 * lib 里统一回 404，不泄露别人的消息是否存在。
 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { messageId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "消息 id 无效" }, { status: 400 });

  try {
    const result = await deleteChatMessage(session.user.id, parsed.data);
    return NextResponse.json({
      deletedIds: result.deletedIds,
      conversationId: result.conversationId,
      lastMessageAt: result.lastMessageAt?.toISOString() ?? null,
    });
  } catch (e) {
    return chatErrorResponse(e, "[DELETE /api/chat/messages/:id]");
  }
}
