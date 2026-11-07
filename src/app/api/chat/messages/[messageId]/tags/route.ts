import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { addMessageTag, removeMessageTag } from "@/lib/agent/message-tags";
import { chatErrorResponse } from "@/lib/agent/chat-http";
import { MESSAGE_TAG_MAX, normalizeMessageTag } from "@/lib/message-tag";

type Ctx = { params: Promise<{ messageId: string }> };

// Next 16：动态段参数是 Promise，必须 await。

const addSchema = z.object({
  tag: z
    .string()
    .trim()
    .min(1, "请输入标签")
    .max(MESSAGE_TAG_MAX, `标签最多 ${MESSAGE_TAG_MAX} 字`),
});

/** 给我的某条助手消息加标签；重复添加幂等，返回该消息当前的全部标签 */
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { messageId: raw } = await ctx.params;
  const parsedId = z.uuid().safeParse(raw);
  if (!parsedId.success) return NextResponse.json({ error: "消息 id 无效" }, { status: 400 });

  const parsed = addSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    const tags = await addMessageTag(session.user.id, parsedId.data, parsed.data.tag);
    // 消息不存在、不是助手消息、或不在我的个人会话里 —— 统一 404，不泄露别人的数据
    if (!tags) return NextResponse.json({ error: "消息不存在" }, { status: 404 });
    return NextResponse.json({ tags });
  } catch (e) {
    return chatErrorResponse(e, "[POST /api/chat/messages/:id/tags]");
  }
}

/** 撤掉一个标签（`?tag=`）；幂等，本来就没有也返回 ok */
export async function DELETE(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { messageId: raw } = await ctx.params;
  const parsedId = z.uuid().safeParse(raw);
  if (!parsedId.success) return NextResponse.json({ error: "消息 id 无效" }, { status: 400 });

  const tag = normalizeMessageTag(new URL(req.url).searchParams.get("tag"));
  if (!tag) return NextResponse.json({ error: "请指定要删除的标签" }, { status: 400 });

  try {
    await removeMessageTag(session.user.id, parsedId.data, tag);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return chatErrorResponse(e, "[DELETE /api/chat/messages/:id/tags]");
  }
}
