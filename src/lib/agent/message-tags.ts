import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, messageTags, messages } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { normalizeMessageTag } from "@/lib/message-tag";

/**
 * 助手消息标签（**每人私有**）。
 *
 * 标签挂在「用户 × 消息」上：同一条答复，甲打了「进度」、乙什么都没打，互不影响。
 * 只允许给**自己个人会话里的助手消息**打标 —— 用户消息、项目共享会话都不开放：
 * 前者是「自己说过的话」，不需要再贴标签；后者属于团队，别人的标签不该出现。
 *
 * 标签值走 `normalizeMessageTag`（trim / 控制字符 / ≤20 码点），同名标签可跨消息复用；
 * (messageId,userId,tag) 唯一，重复添加是幂等的。
 */

export type MessageTagSummary = { tag: string; count: number };

export type TaggedMessage = {
  messageId: string;
  conversationId: string;
  conversationTitle: string | null;
  conversationCategory: string | null;
  /** 消息正文；列表里自行截断展示 */
  content: string;
  createdAt: string; // ISO
  /** 这条消息上**当前用户**的标签（可能不止查询用的那一个） */
  tags: string[];
};

const messageIdSchema = z.uuid();

/** 目标消息：自己的个人会话 + 助手答复；不满足返回 null（路由按 404 处理，不泄露存在性） */
async function findOwnAssistantMessage(actorId: string, messageId: string) {
  if (!messageIdSchema.safeParse(messageId).success) return null;
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.role, "assistant"),
        eq(conversations.kind, "personal"),
        eq(conversations.ownerId, actorId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 一次取多条消息上「我的」标签；返回 messageId → 标签数组（按添加先后） */
export async function listMessageTagsForMessages(
  actorId: string,
  messageIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (messageIds.length === 0) return out;

  const rows = await db
    .select({ messageId: messageTags.messageId, tag: messageTags.tag })
    .from(messageTags)
    .where(and(eq(messageTags.userId, actorId), inArray(messageTags.messageId, [...messageIds])))
    .orderBy(asc(messageTags.createdAt), asc(messageTags.tag));

  for (const row of rows) {
    const list = out.get(row.messageId);
    if (list) list.push(row.tag);
    else out.set(row.messageId, [row.tag]);
  }
  return out;
}

/** 给一条助手消息加标签；消息不存在 / 无权访问 / 不是助手消息 → null。返回该消息的最新标签集 */
export async function addMessageTag(
  actorId: string,
  messageId: string,
  rawTag: string,
): Promise<string[] | null> {
  const tag = normalizeMessageTag(rawTag);
  if (!tag) throw new AppError("标签不能为空");

  const target = await findOwnAssistantMessage(actorId, messageId);
  if (!target) return null;

  await db
    .insert(messageTags)
    .values({ messageId: target.id, userId: actorId, tag })
    .onConflictDoNothing();

  const map = await listMessageTagsForMessages(actorId, [target.id]);
  return map.get(target.id) ?? [];
}

/** 撤掉一个标签；返回是否删除了行（重复撤销/本就没有 → false） */
export async function removeMessageTag(
  actorId: string,
  messageId: string,
  rawTag: string,
): Promise<boolean> {
  const tag = normalizeMessageTag(rawTag);
  if (!tag || !messageIdSchema.safeParse(messageId).success) return false;

  const deleted = await db
    .delete(messageTags)
    .where(
      and(
        eq(messageTags.messageId, messageId),
        eq(messageTags.userId, actorId),
        eq(messageTags.tag, tag),
      ),
    )
    .returning({ id: messageTags.id });
  return deleted.length > 0;
}

/** 我的全部标签及使用次数（面板「标签」页使用），按次数降序 */
export async function listMessageTags(actorId: string, limit = 200): Promise<MessageTagSummary[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  return db
    .select({
      tag: messageTags.tag,
      count: sql<number>`count(*)::int`,
    })
    .from(messageTags)
    .where(eq(messageTags.userId, actorId))
    .groupBy(messageTags.tag)
    .orderBy(desc(sql`count(*)`), asc(messageTags.tag))
    .limit(capped);
}

/**
 * 按标签查历史消息：只返回自己的、仍存在（未随会话删除）的助手消息，
 * 最近的在前。`content` 原样返回，由调用方决定截多少。
 */
export async function listMessagesByTag(
  actorId: string,
  rawTag: string,
  limit = 100,
): Promise<TaggedMessage[]> {
  const tag = normalizeMessageTag(rawTag);
  if (!tag) return [];
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);

  const rows = await db
    .select({
      messageId: messages.id,
      conversationId: conversations.id,
      conversationTitle: conversations.title,
      conversationCategory: conversations.category,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messageTags)
    .innerJoin(messages, eq(messages.id, messageTags.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messageTags.userId, actorId),
        eq(messageTags.tag, tag),
        eq(messages.role, "assistant"),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(capped);

  const tagMap = await listMessageTagsForMessages(
    actorId,
    rows.map((r) => r.messageId),
  );

  return rows.map((r) => ({
    messageId: r.messageId,
    conversationId: r.conversationId,
    conversationTitle: r.conversationTitle,
    conversationCategory: r.conversationCategory,
    content: r.content,
    createdAt: r.createdAt.toISOString(),
    tags: tagMap.get(r.messageId) ?? [],
  }));
}
