import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { conversations, messages } from "@/db/schema";
import { AppError } from "@/lib/errors";
import {
  CONTEXT_MAX_ITEMS,
  CONTEXT_MAX_LENGTH,
  createPersonalContext,
  listMyPersonalContext,
  normalizeContextContent,
} from "@/lib/personal-context";
import { getAiHistoryLimit } from "./memory";
import { normalizeConversationCategory } from "./conversation-category";

/**
 * AI 助手「记忆」的导入 / 导出。
 *
 * 导出的是一个 JSON 快照，装两类东西（用户明确要**两者都要**）：
 * 1. 个人上下文（`personal_contexts`）——「助手了解你的背景」；
 * 2. 个人会话与消息（`conversations` kind=personal + `messages`）——「你们聊过什么」。
 * 另外附带「记得多少上文」的偏好值，便于换环境时对照；**导入不会覆盖它**：
 * 那份偏好是本机的选择，静默改掉比不带更意外。
 *
 * 导入只落成**我的**数据：userId / ownerId 恒取发话人，文件里的任何身份字段一概不认。
 * 会话是新建的（新 id），不会与现有记录合并 —— 幂等由「上下文按正文去重」承担；
 * 同一份文件导两次，上下文不会翻倍，会话会多出一份（那是用户自己选的）。
 *
 * 全部有上限：文件可能来自别处，不能让它把库撑爆。超限的部分跳过并在结果里报数。
 */

export const MEMORY_EXPORT_FORMAT = "agilecampus.assistant-memory";
export const MEMORY_EXPORT_VERSION = 1;

// 导出快照上限：个人会话最多 200 条（与面板列表同量级），每条最多 500 条消息（与面板一致）
const EXPORT_MAX_CONVERSATIONS = 200;
const EXPORT_MAX_MESSAGES_PER_CONVERSATION = 500;

// 导入上限：整份文件最大 5MB / 200 个会话；每条会话最多 2000 条消息
export const MEMORY_IMPORT_MAX_BYTES = 5 * 1024 * 1024;

export type MemoryExportContext = {
  content: string;
  visibility: "shared" | "private";
  source: "manual" | "agent";
  createdAt: string;
  updatedAt: string;
};

export type MemoryExportMessage = {
  role: "user" | "assistant";
  content: string;
  /** 原始落库时间；导入时用它恢复先后顺序（同一轮的问与答时间相同） */
  createdAt: string;
};

export type MemoryExportConversation = {
  title: string | null;
  /** 分类标签；旧的导出文件没有这个字段，导入后按未分类处理 */
  category?: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messages: MemoryExportMessage[];
};

export type MemoryExportDoc = {
  format: typeof MEMORY_EXPORT_FORMAT;
  version: typeof MEMORY_EXPORT_VERSION;
  exportedAt: string;
  settings: { historyLimit: number };
  contexts: MemoryExportContext[];
  conversations: MemoryExportConversation[];
};

export async function exportAssistantMemory(actorId: string): Promise<MemoryExportDoc> {
  const [contexts, historyLimit, convRows] = await Promise.all([
    listMyPersonalContext(actorId),
    getAiHistoryLimit(actorId),
    db
      .select({
        id: conversations.id,
        title: conversations.title,
        category: conversations.category,
        createdAt: conversations.createdAt,
        lastMessageAt: conversations.lastMessageAt,
      })
      .from(conversations)
      .where(and(eq(conversations.kind, "personal"), eq(conversations.ownerId, actorId)))
      .orderBy(desc(conversations.createdAt))
      .limit(EXPORT_MAX_CONVERSATIONS),
  ]);

  const ids = convRows.map((c) => c.id);
  const messageRows =
    ids.length === 0
      ? []
      : await db
          .select({
            conversationId: messages.conversationId,
            role: messages.role,
            content: messages.content,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(
            and(
              inArray(messages.conversationId, ids),
              inArray(messages.role, ["user", "assistant"]),
            ),
          )
          // 同一轮问答时间戳相同：问在上、答在下（与会话读取同一讲究）
          .orderBy(
            asc(messages.createdAt),
            asc(sql`case when ${messages.role} = 'user' then 0 else 1 end`),
          );

  const byConversation = new Map<string, MemoryExportMessage[]>();
  for (const m of messageRows) {
    const list = byConversation.get(m.conversationId) ?? [];
    list.push({
      role: m.role as "user" | "assistant",
      content: m.content,
      createdAt: m.createdAt.toISOString(),
    });
    byConversation.set(m.conversationId, list);
  }

  return {
    format: MEMORY_EXPORT_FORMAT,
    version: MEMORY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: { historyLimit },
    contexts: contexts.map((c) => ({
      content: c.content,
      visibility: c.visibility,
      source: c.source,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    })),
    conversations: convRows.map((c) => ({
      title: c.title,
      category: c.category,
      createdAt: c.createdAt.toISOString(),
      lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      messages: (byConversation.get(c.id) ?? []).slice(0, EXPORT_MAX_MESSAGES_PER_CONVERSATION),
    })),
  };
}

// ---------------------------------------------------------------- 导入

const dateString = z
  .string()
  .optional()
  .transform((value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  });

const importSchema = z.object({
  format: z.literal(MEMORY_EXPORT_FORMAT, {
    message: "这不是 AgileCampus 助手记忆的导出文件",
  }),
  version: z.literal(MEMORY_EXPORT_VERSION, {
    message: "导出文件版本不受支持（请用新版导出）",
  }),
  exportedAt: z.string().optional(),
  settings: z.object({ historyLimit: z.number().optional() }).optional(),
  contexts: z
    .array(
      z.object({
        content: z.string(),
        visibility: z.enum(["shared", "private"]).default("shared"),
        source: z.enum(["manual", "agent"]).default("manual"),
      }),
    )
    .max(1000)
    .default([]),
  conversations: z
    .array(
      z.object({
        title: z.string().max(200).nullable().optional(),
        category: z.string().max(20).nullable().optional(),
        createdAt: dateString,
        // lastMessageAt 不落库——导入后由新消息与 createdAt 重新决定
        messages: z
          .array(
            z.object({
              role: z.enum(["user", "assistant"]),
              content: z.string().min(1).max(50_000),
              createdAt: dateString,
            }),
          )
          .max(2000)
          .default([]),
      }),
    )
    .max(200)
    .default([]),
});

export type MemoryImportResult = {
  contextsAdded: number;
  contextsSkipped: number;
  conversationsAdded: number;
  messagesAdded: number;
};

/** 解析并校验一份导出文件（JSON 文本）。不碰库 —— 路由可以先解析再决定是否落库 */
export function parseMemoryExport(raw: unknown): z.infer<typeof importSchema> {
  const parsed = importSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "文件";
    throw new AppError(`记忆文件格式不对（${where}）：${issue?.message ?? ""}`.trim());
  }
  return parsed.data;
}

/**
 * 导入：上下文按正文去重后追加（受每人 50 条配额约束），会话新建并灌入消息。
 *
 * 消息按「问在上、答在下」重新配对成轮次、共用 turnId —— 之后删除任意一条都能成对删掉，
 * 与站内新产生的对话行为一致。落库时间取文件里的 createdAt（没有就取导入时刻）。
 */
export async function importAssistantMemory(
  actorId: string,
  raw: unknown,
): Promise<MemoryImportResult> {
  const doc = parseMemoryExport(raw);

  const existing = await listMyPersonalContext(actorId);
  const seen = new Set(existing.map((c) => normalizeContextContent(c.content)));
  const room = Math.max(0, CONTEXT_MAX_ITEMS - existing.length);
  const toCreate: { content: string; visibility: "shared" | "private"; source: "manual" | "agent" }[] = [];
  let contextsSkipped = 0;

  for (const entry of doc.contexts) {
    const content = normalizeContextContent(entry.content);
    if (!content || content.length > CONTEXT_MAX_LENGTH || seen.has(content) || toCreate.length >= room) {
      contextsSkipped++;
      continue;
    }
    seen.add(content);
    toCreate.push({ content, visibility: entry.visibility, source: entry.source });
  }

  const importedConversations = doc.conversations.filter((c) => c.messages.length > 0);
  let messagesAdded = 0;

  if (importedConversations.length > 0) {
    await db.transaction(async (tx) => {
      for (const conv of importedConversations) {
        const baseAt = conv.createdAt ?? new Date();
        const [created] = await tx
          .insert(conversations)
          .values({
            kind: "personal",
            ownerId: actorId,
            createdById: actorId,
            title: conv.title?.trim() || null,
            category: normalizeConversationCategory(conv.category),
            createdAt: baseAt,
            lastMessageAt: baseAt,
          })
          .returning({ id: conversations.id });

        const rows: {
          conversationId: string;
          role: "user" | "assistant";
          content: string;
          turnId: string;
          createdAt: Date;
        }[] = [];
        let pendingUser: { content: string; at: Date } | null = null;
        let lastAt = baseAt;

        // 文件没给消息时间时按顺序虚构（每条 +1 秒），至少保证先后不乱
        const timeOf = (value: Date | null, index: number): Date => {
          const at = value ?? new Date(baseAt.getTime() + (index + 1) * 1000);
          lastAt = at;
          return at;
        };

        const flushPending = () => {
          if (!pendingUser) return;
          rows.push({
            conversationId: created.id,
            role: "user",
            content: pendingUser.content,
            turnId: randomUUID(),
            createdAt: pendingUser.at,
          });
          pendingUser = null;
        };

        conv.messages.forEach((message, index) => {
          if (message.role === "user") {
            // 上一条问句没等到答话就来了下一条：先把孤立问句落了
            flushPending();
            pendingUser = { content: message.content, at: timeOf(message.createdAt, index) };
            return;
          }
          if (pendingUser) {
            // 一问一答：同 turnId、同时间戳，与 persistTurn 的落库形态一致
            const turnId = randomUUID();
            rows.push({
              conversationId: created.id,
              role: "user",
              content: pendingUser.content,
              turnId,
              createdAt: pendingUser.at,
            });
            rows.push({
              conversationId: created.id,
              role: "assistant",
              content: message.content,
              turnId,
              createdAt: pendingUser.at,
            });
            pendingUser = null;
          } else {
            rows.push({
              conversationId: created.id,
              role: "assistant",
              content: message.content,
              turnId: randomUUID(),
              createdAt: timeOf(message.createdAt, index),
            });
          }
        });
        flushPending();

        if (rows.length > 0) {
          await tx.insert(messages).values(rows);
          await tx
            .update(conversations)
            .set({ lastMessageAt: lastAt })
            .where(eq(conversations.id, created.id));
          messagesAdded += rows.length;
        }
      }
    });
  }

  if (toCreate.length > 0) {
    await createPersonalContext(actorId, toCreate);
  }

  return {
    contextsAdded: toCreate.length,
    contextsSkipped,
    conversationsAdded: importedConversations.length,
    messagesAdded,
  };
}
