import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { forwardChatMessage } from "@/lib/chat-transfer";

const schema = z
  .object({
    // dm: sourceId 是私信对端 userId；group: sourceId 是群聊 groupId
    sourceType: z.enum(["dm", "group"]),
    sourceId: z.uuid(),
    messageId: z.uuid(),
    toUserId: z.uuid().optional(),
    toGroupId: z.uuid().optional(),
  })
  .refine((d) => !!d.toUserId !== !!d.toGroupId, {
    message: "toUserId 与 toGroupId 必须二选一",
    path: ["toUserId"],
  });

/**
 * POST /api/agent/messages/forward — 把一条已有私信/群消息（连同附件）原样转发。
 * 源消息权限与目标权限都在 lib 层重校；附件复制字节进 dm_attachments。
 */
export async function POST(req: Request) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const d = parsed.data;
  try {
    const result = await forwardChatMessage(
      userId,
      { sourceType: d.sourceType, sourceId: d.sourceId, messageId: d.messageId },
      d.toUserId
        ? { kind: "user", id: d.toUserId }
        : { kind: "group", id: d.toGroupId! },
    );
    return NextResponse.json({
      forwarded: 1,
      sourceType: d.sourceType,
      sourceLabel: result.sourceLabel,
      targetType: d.toUserId ? "user" : "group",
      targetName: result.targetName,
    });
  } catch (e) {
    return mapAgentError(e, "[POST /api/agent/messages/forward]");
  }
}
