import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { createGroup, listGroupConversations } from "@/lib/group-chat";

/** GET /api/agent/groups — 我加入的群聊与未读数。 */
export async function GET(req: Request) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  try {
    const groups = await listGroupConversations(userId);
    return NextResponse.json({
      groups: groups.map((g) => ({
        groupId: g.groupId,
        name: g.name,
        memberCount: g.memberCount,
        unread: g.unread,
        lastAt: g.lastAt,
        preview: g.preview,
        lastSenderName: g.lastSenderName,
      })),
    });
  } catch (e) {
    return mapAgentError(e, "[GET /api/agent/groups]");
  }
}

const createSchema = z.object({
  name: z.string().min(1),
  // 允许空数组：先建一个只有自己的群，之后再邀请成员
  memberIds: z.array(z.uuid()).optional().default([]),
});

/**
 * POST /api/agent/groups — 建群。
 * 与网页建群一致：成员会被**直接拉入群**（不是发邀请待接受）；也可以只有自己。
 */
export async function POST(req: Request) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const memberIds = parsed.data.memberIds.filter((id) => id !== userId);

  try {
    const group = await createGroup(userId, parsed.data.name, memberIds);
    return NextResponse.json({
      id: group.id,
      name: group.name,
      ownerId: group.ownerId,
      memberCount: group.memberCount,
      members: group.members.map((m) => ({ userId: m.userId, name: m.name })),
    });
  } catch (e) {
    return mapAgentError(e, "[POST /api/agent/groups]");
  }
}
