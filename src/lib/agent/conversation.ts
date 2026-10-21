import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import { conversations, messages } from "@/db/schema";
import { getProjectForUser } from "@/lib/project";
import { ForbiddenError, AppError, NotFoundError } from "@/lib/errors";
import type {
  AssistantConversationSummary,
  AssistantPanelMessage,
} from "./assistant-panel-shared";

/**
 * 会话两种形态（见 schema 的 `conversation_kind` 与 `conversations_scope_chk`）：
 *
 * - **项目会话**：`kind='project'`、`projectId` 必填、`ownerId` 为空 —— **全员共享**，
 *   项目页任何人打开看到的都是同一条（这是刻意的：项目助手是团队共用的脑子）。
 *   每项目复用最近一条（MVP 简化：每项目一活跃会话）。
 * - **个人会话**：`kind='personal'`、`ownerId` 必填、`projectId` 为空 —— **只属于本人**，
 *   右侧面板用它。同一用户可以有多条（会话列表），彼此完全独立。
 *
 * 隔离靠两件事：查询恒带 `ownerId = actorId`（本文件），以及**只由 session 取 actorId**
 * （route 层）——请求体里从不接受身份字段。
 *
 * 并发：去掉唯一索引后，「没有就建」不再有库级唯一约束兜底，故按用户加事务级 advisory lock
 * （`withPersonalLock`），把「找最近一条 / 建一条」串行化。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** 会话列表按「最近用过」排序：有消息时间用消息时间，老数据回落到创建时间 */
const PERSONAL_ORDER = [
  desc(sql`coalesce(${conversations.lastMessageAt}, ${conversations.createdAt})`),
  desc(conversations.createdAt),
  desc(conversations.id),
];

function personalWhere(actorId: string) {
  return and(eq(conversations.kind, "personal"), eq(conversations.ownerId, actorId));
}

/** 按用户串行化「新建个人会话」相关的临界区 */
async function withPersonalLock<T>(
  actorId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${actorId}, 0))`);
    return fn(tx);
  });
}

/** 标题取用户第一句的首行：压掉换行/连续空白，最多 24 个码点 */
export function deriveConversationTitle(text: string): string {
  const firstLine = text
    .trim()
    .split(/\r?\n/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(firstLine);
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : firstLine;
}

export type ConversationRow = typeof conversations.$inferSelect;

export type ConversationSummary = {
  id: string;
  title: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
};

export type PersistedTurn = {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  conversationTitle: string | null;
  conversationCreatedAt: Date;
  lastMessageAt: Date;
};

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

/** 我的一条个人会话；id 非法或不属于我一律 null（绝不把非法串塞进 uuid 列） */
export async function getPersonalConversation(
  actorId: string,
  conversationId: string,
): Promise<ConversationRow | null> {
  if (!isUuid(conversationId)) return null;
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), personalWhere(actorId)))
    .limit(1);
  return conv ?? null;
}

/** 我最近用过的个人会话（没有就返回 null）——**只读**，不在只读路径里凭空建会话 */
export async function findLatestPersonalConversation(
  actorId: string,
): Promise<ConversationRow | null> {
  const [conv] = await db
    .select()
    .from(conversations)
    .where(personalWhere(actorId))
    .orderBy(...PERSONAL_ORDER)
    .limit(1);
  return conv ?? null;
}

/**
 * 一轮对话挂在哪条个人会话上：
 * - 给了 id：必须是**我的**个人会话，否则 Forbidden；
 * - 没给：复用最近一条，没有才新建 —— 老 `/api/chat`（不带 conversationId）的语义。
 */
export async function resolvePersonalConversation(
  actorId: string,
  conversationId?: string,
): Promise<ConversationRow> {
  if (conversationId) {
    const conv = await getPersonalConversation(actorId, conversationId);
    if (!conv) throw new ForbiddenError("会话不存在");
    return conv;
  }

  return withPersonalLock(actorId, async (tx) => {
    const [latest] = await tx
      .select()
      .from(conversations)
      .where(personalWhere(actorId))
      .orderBy(...PERSONAL_ORDER)
      .limit(1);
    if (latest) return latest;

    const [created] = await tx
      .insert(conversations)
      .values({ kind: "personal", ownerId: actorId, createdById: actorId })
      .returning();
    return created;
  });
}

/**
 * 「新对话」：最近一条个人会话如果还是空的就复用它（连点两下不堆空行），
 * 否则新建一条。整个过程按用户加锁，与「最近或新建」互斥。
 */
export async function startPersonalConversation(actorId: string): Promise<ConversationRow> {
  return withPersonalLock(actorId, async (tx) => {
    const [latest] = await tx
      .select()
      .from(conversations)
      .where(personalWhere(actorId))
      .orderBy(...PERSONAL_ORDER)
      .limit(1);

    if (latest) {
      const [hasMessage] = await tx
        .select({ one: sql<number>`1` })
        .from(messages)
        .where(eq(messages.conversationId, latest.id))
        .limit(1);
      if (!hasMessage) return latest;
    }

    const [created] = await tx
      .insert(conversations)
      .values({ kind: "personal", ownerId: actorId, createdById: actorId })
      .returning();
    return created;
  });
}

export async function listPersonalConversations(
  actorId: string,
  limit = 100,
): Promise<ConversationSummary[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 200);
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(personalWhere(actorId))
    .orderBy(...PERSONAL_ORDER)
    .limit(capped);
}

/**
 * 面板切换会话时读的消息。权限先收口，再取最近 `limit` 条并反转
 * （同一轮问答 `created_at` 相同，按「答在下、问在上」排）。
 * **不丢开头的 assistant**：这是给人看的转录，截断本就可能落在一问一答中间。
 */
export async function listPersonalConversationMessages(
  actorId: string,
  conversationId: string,
  limit = 200,
): Promise<AssistantPanelMessage[]> {
  const conv = await getPersonalConversation(actorId, conversationId);
  if (!conv) throw new ForbiddenError("会话不存在");

  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await db
    .select({ id: messages.id, role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        inArray(messages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(
      desc(messages.createdAt),
      desc(sql`case when ${messages.role} = 'assistant' then 1 else 0 end`),
    )
    .limit(capped);

  return rows.reverse().map((r) => ({
    id: r.id,
    role: r.role as "user" | "assistant",
    content: r.content,
  }));
}

export async function renamePersonalConversation(
  actorId: string,
  conversationId: string,
  title: string,
): Promise<ConversationSummary | null> {
  if (!isUuid(conversationId)) return null;
  const next = title.trim();
  if (!next) return null;

  const [updated] = await db
    .update(conversations)
    .set({ title: next })
    .where(and(eq(conversations.id, conversationId), personalWhere(actorId)))
    .returning({
      id: conversations.id,
      title: conversations.title,
      createdAt: conversations.createdAt,
      lastMessageAt: conversations.lastMessageAt,
    });
  return updated ?? null;
}

export async function deletePersonalConversation(
  actorId: string,
  conversationId: string,
): Promise<boolean> {
  if (!isUuid(conversationId)) return false;
  const deleted = await db
    .delete(conversations)
    .where(and(eq(conversations.id, conversationId), personalWhere(actorId)))
    .returning({ id: conversations.id });
  return deleted.length > 0;
}

/** 设置页「删除我的全部聊天记录」：只删本人的 personal 会话，消息随外键级联 */
export async function deleteAllPersonalConversations(actorId: string): Promise<number> {
  return withPersonalLock(actorId, async (tx) => {
    const deleted = await tx
      .delete(conversations)
      .where(personalWhere(actorId))
      .returning({ id: conversations.id });
    return deleted.length;
  });
}

export async function countPersonalConversations(actorId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(conversations)
    .where(personalWhere(actorId));
  return row?.n ?? 0;
}

/** 服务端 Date → 客户端 ISO；API 路由与 layout 共用同一边界 */
export function toAssistantConversationSummary(
  c: ConversationSummary,
): AssistantConversationSummary {
  return {
    id: c.id,
    title: c.title,
    createdAt: c.createdAt.toISOString(),
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
  };
}

/**
 * layout 一次取齐面板要的东西：会话列表、上次看的那条、那条的消息。
 * **只读**：cookie 指向的 id 也必须先校验归属；无效时回落到最近一条。
 */
export async function getAssistantPanelData(
  actorId: string,
  preferredConversationId?: string | null,
): Promise<{
  conversations: AssistantConversationSummary[];
  activeId: string | null;
  messages: AssistantPanelMessage[];
}> {
  const conversations = await listPersonalConversations(actorId);
  let activeId: string | null = null;

  if (preferredConversationId && isUuid(preferredConversationId)) {
    const hit = conversations.find((c) => c.id === preferredConversationId);
    if (hit) {
      activeId = hit.id;
    } else {
      // 超过列表上限、但确实属于我：补到最前面，别让 cookie 指向「看不见的会话」
      const conv = await getPersonalConversation(actorId, preferredConversationId);
      if (conv) {
        activeId = conv.id;
        conversations.unshift(conv);
      }
    }
  }

  if (!activeId) activeId = conversations[0]?.id ?? null;
  const messageRows = activeId
    ? await listPersonalConversationMessages(actorId, activeId)
    : [];

  return {
    conversations: conversations.map(toAssistantConversationSummary),
    activeId,
    messages: messageRows,
  };
}

export type ToolTraceEntry = { toolName: string; input: unknown; output: unknown };

/**
 * 落一轮问答：一条 INSERT 写 user + assistant，两行共用 `turnId` 与 `created_at`。
 * 同时推进会话的 `lastMessageAt`；**仅在一个会话的第一轮**自动生成标题
 * （老会话 title 为空但已有消息时不补，否则标题会描述最新一句而不是整段对话）。
 */
export async function persistTurn(
  conversationId: string,
  userText: string,
  assistantText: string,
  toolTrace: ToolTraceEntry[],
): Promise<PersistedTurn> {
  const turnId = randomUUID();

  return db.transaction(async (tx) => {
    const [state] = await tx
      .select({
        title: conversations.title,
        createdAt: conversations.createdAt,
        messageCount: sql<number>`(
          select count(*)::int from ${messages}
          where ${messages.conversationId} = ${conversationId}
        )`,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .for("update");
    if (!state) throw new AppError("会话不存在");

    const inserted = await tx
      .insert(messages)
      .values([
        { conversationId, role: "user", content: userText, turnId },
        {
          conversationId,
          role: "assistant",
          content: assistantText,
          toolCalls: toolTrace.length > 0 ? toolTrace : null,
          turnId,
        },
      ])
      .returning({ id: messages.id, role: messages.role });

    const userRow = inserted.find((r) => r.role === "user");
    const assistantRow = inserted.find((r) => r.role === "assistant");
    if (!userRow || !assistantRow) throw new AppError("消息落库失败");

    const nextTitle =
      state.title ?? (state.messageCount === 0 ? deriveConversationTitle(userText) : null);

    const [conv] = await tx
      .update(conversations)
      .set({
        // SQL now()：走库时钟。传 JS Date 会经 dbTimestamp 的写方向，只保留毫秒
        lastMessageAt: sql`now()`,
        ...(nextTitle ? { title: nextTitle } : {}),
      })
      .where(eq(conversations.id, conversationId))
      .returning({ title: conversations.title, lastMessageAt: conversations.lastMessageAt });

    return {
      turnId,
      userMessageId: userRow.id,
      assistantMessageId: assistantRow.id,
      conversationTitle: conv?.title ?? state.title,
      conversationCreatedAt: state.createdAt,
      lastMessageAt: conv?.lastMessageAt ?? new Date(),
    };
  });
}

/**
 * 删除一条消息 —— **成对删除**它所在的那一轮。
 *
 * 新数据靠 `turnId`；老数据没有 turnId，退回按原始 `created_at` 相等配对。
 * 老数据这一支**必须在 SQL 里直接比较列**：`dbWallClock` 读方向把微秒截成毫秒
 * （lib/time.ts），拿读回来的 Date 再当参数写回去永远对不上。
 */
export async function deleteChatMessage(
  actorId: string,
  messageId: string,
): Promise<{ deletedIds: string[]; conversationId: string; lastMessageAt: Date | null }> {
  if (!isUuid(messageId)) throw new NotFoundError("消息不存在");

  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        conversationId: messages.conversationId,
        turnId: messages.turnId,
        kind: conversations.kind,
        ownerId: conversations.ownerId,
      })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(eq(messages.id, messageId));

    if (!target || target.kind !== "personal" || target.ownerId !== actorId) {
      throw new NotFoundError("消息不存在");
    }

    const deleted = target.turnId
      ? await tx
          .delete(messages)
          .where(
            and(
              eq(messages.conversationId, target.conversationId),
              eq(messages.turnId, target.turnId),
            ),
          )
          .returning({ id: messages.id })
      : await tx
          .delete(messages)
          .where(
            and(
              eq(messages.conversationId, target.conversationId),
              sql`${messages.createdAt} = (
                select legacy.created_at
                from ${messages} as legacy
                where legacy.id = ${messageId}
              )`,
            ),
          )
          .returning({ id: messages.id });

    const [conv] = await tx
      .update(conversations)
      .set({
        lastMessageAt: sql`(
          select max(${messages.createdAt})
          from ${messages}
          where ${messages.conversationId} = ${target.conversationId}
        )`,
      })
      .where(eq(conversations.id, target.conversationId))
      .returning({ lastMessageAt: conversations.lastMessageAt });

    return {
      deletedIds: deleted.map((r) => r.id),
      conversationId: target.conversationId,
      lastMessageAt: conv?.lastMessageAt ?? null,
    };
  });
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
    // 同一轮问答时间戳相同：问在上、答在下，别让顺序看 PG 心情
    .orderBy(
      asc(messages.createdAt),
      asc(sql`case when ${messages.role} = 'user' then 0 else 1 end`),
    );
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
    .orderBy(
      asc(messages.createdAt),
      asc(sql`case when ${messages.role} = 'user' then 0 else 1 end`),
    );
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

/**
 * 兼容入口：我**最近一条**个人会话的消息（无则空）。多会话改版后 layout 已改用
 * `getAssistantPanelData`，这里保留给「只想看最近一条」的调用/测试。
 */
export async function listPersonalChatHistory(
  actorId: string,
  limit = 200,
): Promise<ChatHistoryMessage[]> {
  const conv = await findLatestPersonalConversation(actorId);
  if (!conv) return [];

  const capped = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const rows = await db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conv.id),
        inArray(messages.role, ["user", "assistant"]),
      ),
    )
    .orderBy(
      desc(messages.createdAt),
      desc(sql`case when ${messages.role} = 'assistant' then 1 else 0 end`),
    )
    .limit(capped);

  return rows
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

// 兼容别名：老代码/测试里「每人只有一条」的说法已不成立，语义收窄为「最近一条」。
export const findPersonalConversation = findLatestPersonalConversation;
export const getOrCreatePersonalConversation = resolvePersonalConversation;

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
