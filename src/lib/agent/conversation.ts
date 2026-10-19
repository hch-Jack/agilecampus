import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { getProjectForUser } from "@/lib/project";
import { ForbiddenError, AppError } from "@/lib/errors";

/**
 * 会话两种形态（见 schema 的 `conversation_kind` 与 `conversations_scope_chk`）：
 *
 * - **项目会话**：`kind='project'`、`projectId` 必填、`ownerId` 为空 —— **全员共享**，
 *   项目页任何人打开看到的都是同一条（这是刻意的：项目助手是团队共用的脑子）。
 *   每项目复用最近一条（MVP 简化：每项目一活跃会话）。
 * - **个人会话**：`kind='personal'`、`ownerId` 必填、`projectId` 为空 —— **只属于本人**，
 *   控制台助手（工作台）用它。唯一索引保证每人恰一条。
 *
 * 隔离靠两件事：查询恒带 `ownerId = actorId`（本文件），以及**只由 session 取 actorId**
 * （route 层）——请求体里从不接受身份字段。
 */

export async function getOrCreateConversation(actorId: string, projectId: string) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  const [existing] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.projectId, projectId))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({ kind: "project", projectId, createdById: actorId })
    .returning();
  return created;
}

/** 我已有的个人会话（没有就返回 null）——**只读**，供页面渲染历史，不在只读路径里凭空建会话 */
export async function findPersonalConversation(actorId: string) {
  const [existing] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.kind, "personal"), eq(conversations.ownerId, actorId)))
    .limit(1);
  return existing ?? null;
}

/** 我的个人会话（没有就建一条）。个人会话无项目可依，权限即「本人」二字 */
export async function getOrCreatePersonalConversation(actorId: string) {
  const existing = await findPersonalConversation(actorId);
  if (existing) return existing;

  const [created] = await db
    .insert(conversations)
    .values({ kind: "personal", ownerId: actorId, createdById: actorId })
    .onConflictDoNothing()
    .returning();
  if (created) return created;

  // 并发首轮：两个请求同时发现「还没有会话」，一个插成功、另一个撞唯一索引。
  // 撞了的回读那一条，于是第二轮起两人共用同一条线（各人各自的线）。
  const raced = await findPersonalConversation(actorId);
  if (!raced) throw new AppError("会话创建失败，请重试");
  return raced;
}

export type ToolTraceEntry = { toolName: string; input: unknown; output: unknown };

export async function persistTurn(
  conversationId: string,
  userText: string,
  assistantText: string,
  toolTrace: ToolTraceEntry[],
) {
  await db.insert(messages).values([
    { conversationId, role: "user", content: userText },
    {
      conversationId,
      role: "assistant",
      content: assistantText,
      toolCalls: toolTrace.length > 0 ? toolTrace : null,
    },
  ]);
}

export async function listConversationMessages(actorId: string, conversationId: string) {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conv) throw new AppError("会话不存在");
  await assertCanReadConversation(actorId, conv);

  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}

/** 读一条会话的资格：个人的看归属，项目的看项目访问权 */
async function assertCanReadConversation(
  actorId: string,
  conv: typeof conversations.$inferSelect,
) {
  if (conv.kind === "personal") {
    if (conv.ownerId !== actorId) throw new ForbiddenError();
    return;
  }
  // project 会话的 projectId 由 CHECK 保证非空
  const access = conv.projectId ? await getProjectForUser(actorId, conv.projectId) : null;
  if (!access) throw new ForbiddenError();
}

export type ChatHistoryMessage = { role: "user" | "assistant"; content: string };

/**
 * 喂给模型的「上文」：本会话最近的 `limit` 条聊天记录，按时间正序。
 * **不含本轮**——本轮的用户消息此刻还没落库（落库在模型答完之后，见 `persistTurn`）。
 *
 * 三处讲究：
 * 1. 要的是**最近** limit 条，故先倒序取再反转；正序取 limit 条那是「最早的头几条」。
 * 2. 同一轮的问与答是**同一条 INSERT** 落的，`now()` 在一条语句里取值相同，`created_at`
 *    逐字相等。故必须补一个排序列（答在下、问在上），否则谁先谁后全看 PG 心情。
 * 3. 反转后开头若是「答」，一律丢掉：一段以答话打头的上下文没有意义，
 *    而且有些模型不接受以 assistant 打头的 messages。
 *
 * 长度上限由调用方按用户偏好给（见 agent/memory.ts），这里不再二次截断。
 */
export async function recentMessagesForModel(
  conversationId: string,
  limit: number,
): Promise<ChatHistoryMessage[]> {
  if (limit <= 0) return [];

  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        inArray(messages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(
      desc(messages.createdAt),
      desc(sql`case when ${messages.role} = 'assistant' then 1 else 0 end`),
    )
    .limit(limit);

  const ordered: ChatHistoryMessage[] = rows
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
  while (ordered.length > 0 && ordered[0].role === "assistant") ordered.shift();
  return ordered;
}

async function historyOf(conversationId: string): Promise<ChatHistoryMessage[]> {
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
  // tool 角色不单独成行（工具轨迹并进 assistant 消息的 toolCalls），渲染层不需要它
  return rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
}

/** 项目页历史：该项目最近一条会话的消息（无则空）。权限经 getProjectForUser 收敛 */
export async function listProjectChatHistory(
  actorId: string,
  projectId: string,
): Promise<ChatHistoryMessage[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  // kind 是冗余但刻意的：CHECK 已保证 personal 行的 projectId 必为空，这里再钉一遍，
  // 将来万一放宽了那条约束，个人会话也不会串进项目页
  const [latest] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, "project"), eq(conversations.projectId, projectId)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  return latest ? historyOf(latest.id) : [];
}

/** 工作台历史：**我的**个人会话的消息（无则空）。读的行永远归我，故无需额外校验 */
export async function listPersonalChatHistory(actorId: string): Promise<ChatHistoryMessage[]> {
  const conv = await findPersonalConversation(actorId);
  return conv ? historyOf(conv.id) : [];
}

export type ChatHistoryEntry = {
  role: "user" | "assistant";
  content: string;
  at: string; // ISO
};

/**
 * 助手工具用的「翻更早的对话」：与自动上文不同，这里由用户显式要，故不受
 * `ai_history_limit` 约束（工具层钳 1..50）。取最近 limit 条后反转成时间正序；
 * 保留切片开头的 assistant —— 这是**读历史**，不是喂给模型的 messages。
 */
export async function listProjectChatHistoryForTool(
  actorId: string,
  projectId: string,
  limit = 20,
): Promise<ChatHistoryEntry[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  const capped = Math.min(Math.max(Math.trunc(limit), 1), 50);

  const [latest] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.kind, "project"), eq(conversations.projectId, projectId)))
    .orderBy(desc(conversations.createdAt))
    .limit(1);
  if (!latest) return [];

  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, latest.id),
        inArray(messages.role, ["user", "assistant"]),
      ),
    )
    // 同一轮问答时间戳相同：答在下、问在上（与 recentMessagesForModel 同一讲究）
    .orderBy(
      desc(messages.createdAt),
      desc(sql`case when ${messages.role} = 'assistant' then 1 else 0 end`),
    )
    .limit(capped);

  return rows.reverse().map((r) => ({
    role: r.role as "user" | "assistant",
    content: r.content.length > 1000 ? `${r.content.slice(0, 1000)}…` : r.content,
    at: r.createdAt.toISOString(),
  }));
}
