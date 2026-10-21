import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { findUserByUsername, listConversations } from "@/lib/dm";

/**
 * GET /api/agent/contacts
 * - 不带参数：列出我的私信联系人（含未读数与最近一条预览）。
 * - `?username=foo`：按用户名精确查人（不建会话、不改变未读），返回 userId。
 *
 * 「寻找联系人」与「发消息前取 userId」都走这里；模糊搜索刻意不做——用户名全站唯一，
 * 精确命中足以定位，也避免把全站用户名暴露成可枚举的搜索接口。
 */
export async function GET(req: Request) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const username = new URL(req.url).searchParams.get("username");
  try {
    if (username !== null) {
      const parsed = z.string().trim().min(1).safeParse(username);
      if (!parsed.success) {
        return NextResponse.json({ error: "username 不能为空" }, { status: 400 });
      }
      const user = await findUserByUsername(userId, parsed.data);
      return NextResponse.json({ user: { id: user.id, name: user.name } });
    }

    const contacts = await listConversations(userId);
    return NextResponse.json({
      contacts: contacts.map((c) => ({
        peerId: c.peerId,
        name: c.peerName,
        unread: c.unread,
        lastAt: c.lastAt,
        preview: c.preview,
        lastMine: c.lastMine,
      })),
    });
  } catch (e) {
    return mapAgentError(e, "[GET /api/agent/contacts]");
  }
}
