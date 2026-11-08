import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  deletePersonalConversation,
  getPersonalConversation,
  listPersonalConversationMessages,
  renamePersonalConversation,
  setPersonalConversationCategory,
  toAssistantConversationSummary,
  type ConversationSummary,
} from "@/lib/agent/conversation";
import { chatErrorResponse } from "@/lib/agent/chat-http";

type Ctx = { params: Promise<{ conversationId: string }> };

// Next 16：动态段参数是 Promise，必须 await。

// 改名与分类可单独改，也可一次改两样；category=null 表示恢复「未分类」
const patchSchema = z
  .object({
    title: z.string().trim().min(1, "请输入标题").max(60, "标题最多 60 字").optional(),
    category: z.string().trim().max(20, "分类最多 20 字").nullable().optional(),
  })
  .refine((d) => d.title !== undefined || d.category !== undefined, {
    message: "没有要修改的内容",
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

/** 改名 / 改分类；只能改自己的个人会话 */
export async function PATCH(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { conversationId: raw } = await ctx.params;
  const parsedId = z.uuid().safeParse(raw);
  if (!parsedId.success) return NextResponse.json({ error: "会话 id 无效" }, { status: 400 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    const conv = await getPersonalConversation(session.user.id, parsedId.data);
    if (!conv) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

    let updated: ConversationSummary | null = null;
    if (parsed.data.title !== undefined) {
      updated = await renamePersonalConversation(
        session.user.id,
        parsedId.data,
        parsed.data.title,
      );
    }
    if (parsed.data.category !== undefined) {
      updated = await setPersonalConversationCategory(
        session.user.id,
        parsedId.data,
        parsed.data.category,
      );
    }
    if (!updated) return NextResponse.json({ error: "会话不存在" }, { status: 404 });

    return NextResponse.json({
      conversation: toAssistantConversationSummary(updated),
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
