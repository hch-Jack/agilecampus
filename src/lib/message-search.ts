import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "@/db";
import {
  dmAttachments,
  dmGroupMembers,
  dmGroupMessages,
  dmGroups,
  dmMessages,
  users,
} from "@/db/schema";
import { AppError, ForbiddenError } from "@/lib/errors";

/**
 * 跨私信 / 群聊的关键词搜索（助手「找相关消息」用）。
 *
 * 权限口径与聊天窗口一致：私信只搜我收发的，群聊只搜我仍是成员的群；
 * 只读，不置已读、不建联系人 —— 助手搜到不等于用户看过。
 */

export const MESSAGE_SEARCH_MAX_QUERY = 100;
export const MESSAGE_SEARCH_DEFAULT_LIMIT = 20;
export const MESSAGE_SEARCH_MAX_LIMIT = 50;

export type MessageSearchHit = {
  messageId: string;
  kind: "dm" | "group";
  /** 私信 = 对端 userId；群聊 = groupId */
  conversationId: string;
  conversationName: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  content: string;
  createdAt: string;
  attachmentFilename: string | null;
};

/** LIKE 通配符转义：用户搜 "100%" 时按字面量匹配，别把整表都捞出来 */
function likePattern(keyword: string): string {
  return `%${keyword.replace(/[\\%_]/g, "\\$&")}%`;
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function capLimit(raw: number | undefined): number {
  const n = raw ?? MESSAGE_SEARCH_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(n), 1), MESSAGE_SEARCH_MAX_LIMIT);
}

/**
 * 搜我可见的消息正文，按时间倒序返回。query 去掉首尾空白后为空返回空数组
 * （模型偶尔会把可选的 query 传空，没必要抛错打断整轮）。
 */
export async function searchMessages(
  actorId: string,
  rawQuery: string,
  limit?: number,
): Promise<MessageSearchHit[]> {
  const keyword = rawQuery.trim().slice(0, MESSAGE_SEARCH_MAX_QUERY);
  if (!keyword) return [];
  const pattern = likePattern(keyword);
  const cap = capLimit(limit);

  const [dmRows, groupRows] = await Promise.all([
    db
      .select({
        id: dmMessages.id,
        senderId: dmMessages.senderId,
        recipientId: dmMessages.recipientId,
        content: dmMessages.content,
        createdAt: dmMessages.createdAt,
        attachmentFilename: dmAttachments.filename,
      })
      .from(dmMessages)
      .leftJoin(dmAttachments, eq(dmMessages.attachmentId, dmAttachments.id))
      .where(
        and(
          or(eq(dmMessages.senderId, actorId), eq(dmMessages.recipientId, actorId)),
          ilike(dmMessages.content, pattern),
        ),
      )
      .orderBy(desc(dmMessages.createdAt))
      .limit(cap),
    db
      .select({
        id: dmGroupMessages.id,
        groupId: dmGroupMessages.groupId,
        groupName: dmGroups.name,
        senderId: dmGroupMessages.senderId,
        senderName: users.name,
        content: dmGroupMessages.content,
        createdAt: dmGroupMessages.createdAt,
        attachmentFilename: dmAttachments.filename,
      })
      .from(dmGroupMessages)
      // 成员关系决定可见性：不在群里就搜不到该群的消息
      .innerJoin(
        dmGroupMembers,
        and(
          eq(dmGroupMembers.groupId, dmGroupMessages.groupId),
          eq(dmGroupMembers.userId, actorId),
        ),
      )
      .innerJoin(dmGroups, eq(dmGroups.id, dmGroupMessages.groupId))
      .innerJoin(users, eq(users.id, dmGroupMessages.senderId))
      .leftJoin(dmAttachments, eq(dmGroupMessages.attachmentId, dmAttachments.id))
      .where(ilike(dmGroupMessages.content, pattern))
      .orderBy(desc(dmGroupMessages.createdAt))
      .limit(cap),
  ]);

  // 私信行只带了收发双方 id，一次批量补名字（最多 cap*2 个用户）
  const userIds = new Set<string>();
  for (const row of dmRows) {
    userIds.add(row.senderId);
    userIds.add(row.recipientId);
  }
  const nameRows =
    userIds.size > 0
      ? await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, [...userIds]))
      : [];
  const names = new Map(nameRows.map((u) => [u.id, u.name]));

  const hits: MessageSearchHit[] = [
    ...dmRows.map((row) => {
      const peerId = row.senderId === actorId ? row.recipientId : row.senderId;
      return {
        messageId: row.id,
        kind: "dm" as const,
        conversationId: peerId,
        conversationName: names.get(peerId) ?? "未知用户",
        senderId: row.senderId,
        senderName: names.get(row.senderId) ?? "未知用户",
        mine: row.senderId === actorId,
        content: clip(row.content),
        createdAt: row.createdAt.toISOString(),
        attachmentFilename: row.attachmentFilename ?? null,
      };
    }),
    ...groupRows.map((row) => ({
      messageId: row.id,
      kind: "group" as const,
      conversationId: row.groupId,
      conversationName: row.groupName,
      senderId: row.senderId,
      senderName: row.senderName,
      mine: row.senderId === actorId,
      content: clip(row.content),
      createdAt: row.createdAt.toISOString(),
      attachmentFilename: row.attachmentFilename ?? null,
    })),
  ];

  hits.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return hits.slice(0, cap);
}

export type MessageJumpTarget = {
  kind: "dm" | "group";
  conversationId: string;
  conversationName: string;
  messageId: string;
};

/**
 * 跳转前的定位与鉴权：按 messageId 找会话，确认这条消息确实属于我可见的会话。
 * 与 searchMessages 不同，这里必须找不到就报错 —— 前端要据此打开具体会话。
 */
export async function getMessageJumpTarget(
  actorId: string,
  messageId: string,
): Promise<MessageJumpTarget> {
  const [dm] = await db
    .select({ id: dmMessages.id, senderId: dmMessages.senderId, recipientId: dmMessages.recipientId })
    .from(dmMessages)
    .where(
      and(
        eq(dmMessages.id, messageId),
        or(eq(dmMessages.senderId, actorId), eq(dmMessages.recipientId, actorId)),
      ),
    );
  if (dm) {
    const peerId = dm.senderId === actorId ? dm.recipientId : dm.senderId;
    const [peer] = await db.select({ name: users.name }).from(users).where(eq(users.id, peerId));
    return {
      kind: "dm",
      conversationId: peerId,
      conversationName: peer?.name ?? "未知用户",
      messageId: dm.id,
    };
  }

  const [group] = await db
    .select({ id: dmGroupMessages.id, groupId: dmGroupMessages.groupId, groupName: dmGroups.name })
    .from(dmGroupMessages)
    .innerJoin(
      dmGroupMembers,
      and(
        eq(dmGroupMembers.groupId, dmGroupMessages.groupId),
        eq(dmGroupMembers.userId, actorId),
      ),
    )
    .innerJoin(dmGroups, eq(dmGroups.id, dmGroupMessages.groupId))
    .where(eq(dmGroupMessages.id, messageId));
  if (group) {
    return {
      kind: "group",
      conversationId: group.groupId,
      conversationName: group.groupName,
      messageId: group.id,
    };
  }

  throw new ForbiddenError("消息不存在或无权查看");
}

export function assertMessageId(messageId: string): string {
  // 任务/消息 id 都是 uuid；这里只挡明显非法的形状（16 进制 8-4-4-4-12）
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(messageId)) {
    throw new AppError("消息 id 格式不正确");
  }
  return messageId;
}
