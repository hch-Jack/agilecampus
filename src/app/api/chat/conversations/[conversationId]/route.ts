import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  deletePersonalConversation,
  getPersonalConversation,
  listPersonalConversationMessages,
  renamePersonalConversation,
  toAssistantConversationSummary,
} from "@/lib/agent/conversation";
import { chatErrorResponse } from "@/lib/agent/chat-http";

type Ctx = { params: Promise<{ conversationId: string }> };

// Next 16：动态段参数是 Promise，必须 await。

const renameSchema = z.object({
  title: z.string().trim().min(1, "请输入标题").max(60, "标题最多 60 字"),
});

/** 切换会话：取这条会话的基本信息与最近 200 条消息 */
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { conversationId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "会话 id 无效" }, { status: 400 });

  try {
    const conv = await getPersonalConversation(session.user.id, parsed.data);
    if (!conv) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

    const messages = await listPersonalConversationMessages(
      session.user.id,
      conv.id,
    );
    return NextResponse.json({
      conversation: toAssistantConversationSummary(conv),
      messages,
    });
  } catch (e) {
    return chatErrorResponse(e, "[GET /api/chat/conversations/:id]");
  }
}

/** 改名；只能改自己的个人会话 */
export async function PATCH(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { conversationId: raw } = await ctx.params;
  const parsedId = z.uuid().safeParse(raw);
  if (!parsedId.success) return NextResponse.json({ error: "会话 id 无效" }, { status: 400 });

  const parsed = renameSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    const conv = await renamePersonalConversation(
      session.user.id,
      parsedId.data,
      parsed.data.title,
    );
    if (!conv) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

    return NextResponse.json({
      conversation: toAssistantConversationSummary(conv),
    });
  } catch (e) {
    return chatErrorResponse(e, "[PATCH /api/chat/conversations/:id]");
  }
}

/** 删除会话；消息随外键级联。只能删自己的个人会话 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { conversationId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "会话 id 无效" }, { status: 400 });

  try {
    const ok = await deletePersonalConversation(session.user.id, parsed.data);
    if (!ok) return NextResponse.json({ error: "会话不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return chatErrorResponse(e, "[DELETE /api/chat/conversations/:id]");
  }
}
