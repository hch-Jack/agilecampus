import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { listDmMessagesReadOnly } from "@/lib/dm";
import { listGroupMessagesReadOnly } from "@/lib/group-chat";
import { sendChatMessage } from "@/lib/chat-transfer";

const querySchema = z.object({
  peerId: z.uuid().optional(),
  groupId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/**
 * GET /api/agent/messages?peerId=... | ?groupId=...
 * 只读最近消息（默认 20，最多 50）：不标记已读、不建联系人。
 */
export async function GET(req: Request) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    peerId: url.searchParams.get("peerId") ?? undefined,
    groupId: url.searchParams.get("groupId") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const { peerId, groupId, limit } = parsed.data;
  if (!!peerId === !!groupId) {
    return NextResponse.json({ error: "peerId 与 groupId 必须二选一" }, { status: 400 });
  }

  try {
    if (peerId) {
      const thread = await listDmMessagesReadOnly(userId, peerId, limit ?? 20);
      return NextResponse.json({
        kind: "dm",
        peer: { id: thread.peer.id, name: thread.peer.name },
        messages: thread.messages.map((m) => ({
          id: m.id,
          mine: m.mine,
          content: m.content,
          at: m.createdAt,
          attachment: m.attachment
            ? {
                attachmentId: m.attachment.id,
                filename: m.attachment.filename,
                size: m.attachment.size,
              }
            : null,
        })),
        hasMore: thread.hasMore,
      });
    }

    const thread = await listGroupMessagesReadOnly(userId, groupId!, limit ?? 20);
    return NextResponse.json({
      kind: "group",
      group: thread.group,
      messages: thread.messages.map((m) => ({
        id: m.id,
        senderId: m.senderId,
        senderName: m.senderName,
        mine: m.mine,
        content: m.content,
        at: m.createdAt,
        attachment: m.attachment
          ? {
              attachmentId: m.attachment.id,
              filename: m.attachment.filename,
              size: m.attachment.size,
            }
          : null,
      })),
      hasMore: thread.hasMore,
    });
  } catch (e) {
    return mapAgentError(e, "[GET /api/agent/messages]");
  }
}

const sendSchema = z
  .object({
    toUserId: z.uuid().optional(),
    toGroupId: z.uuid().optional(),
    content: z.string().optional(),
    // 文件只按 id 引用已有附件：task=任务附件，message=消息附件（转发文件）。
    // 不接受 base64/二进制上传——上传仍走网页表单。
    attachment: z
      .object({
        source: z.enum(["task", "message"]),
        attachmentId: z.uuid(),
      })
      .nullable()
      .optional(),
  })
  .refine((d) => !!d.toUserId !== !!d.toGroupId, {
    message: "toUserId 与 toGroupId 必须二选一",
    path: ["toUserId"],
  });

/** POST /api/agent/messages — 发私信或群消息（文本与附件至少其一）。 */
export async function POST(req: Request) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const parsed = sendSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  const d = parsed.data;
  try {
    const result = await sendChatMessage(
      userId,
      d.toUserId
        ? { kind: "user", id: d.toUserId }
        : { kind: "group", id: d.toGroupId! },
      { content: d.content ?? "", attachment: d.attachment ?? null },
    );
    return NextResponse.json({
      sent: 1,
      targetType: d.toUserId ? "user" : "group",
      targetName: result.targetName,
    });
  } catch (e) {
    return mapAgentError(e, "[POST /api/agent/messages]");
  }
}
