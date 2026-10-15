import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dmAttachments,
  dmContacts,
  dmGroupMembers,
  dmGroupMessages,
  dmMessages,
  users,
  type UserIdentity,
} from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { userAvatarUrl } from "./user";

// 单文件大小上限：10MB，与任务附件同限。上传走 server action，
// 体积限制与 next.config 的 experimental.serverActions.bodySizeLimit（12mb）配套。
export const DM_ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024;

// 会话对端的展示信息（聊天窗口头部 / 搜索命中返回）。类型放这里而非 "use server"
// 文件——server action 文件里 re-export 类型会被 Turbopack 误编译成运行时导出（ReferenceError）。
export type DmPeer = {
  id: string;
  name: string;
  identity: UserIdentity | null;
  // 头像地址（带 ?v= 版本号）；null=没传过头像，前端回落成名字首字
  avatarUrl: string | null;
};

// —— 搜索与添加 ——

// 按用户名精准找人：用户名全站唯一（注册查重 + DB 唯一索引兜底），不区分大小写恰命中一人。
// 未命中 / 搜到自己均抛可展示错误，由前端提示重新输入。
export async function findUserByUsername(actorId: string, rawName: string) {
  const name = rawName.trim();
  if (!name) throw new AppError("请输入用户名");
  const [user] = await db
    .select({
      id: users.id,
      name: users.name,
      identity: users.identity,
      avatarUpdatedAt: users.avatarUpdatedAt,
    })
    .from(users)
    .where(sql`lower(${users.name}) = lower(${name})`);
  if (!user) throw new AppError("用户不存在，请检查用户名后重新输入");
  if (user.id === actorId) throw new AppError("这是你自己，换个名字试试");
  return { ...user, avatarUrl: userAvatarUrl(user.id, user.avatarUpdatedAt) };
}

// 会话行（幂等）：无则建，有则原样返回。onConflictDoNothing 兜并发，空手而归时回查。
async function ensureContact(ownerId: string, peerId: string) {
  const [existing] = await db
    .select()
    .from(dmContacts)
    .where(and(eq(dmContacts.ownerId, ownerId), eq(dmContacts.peerId, peerId)));
  if (existing) return existing;
  const [inserted] = await db
    .insert(dmContacts)
    .values({ ownerId, peerId })
    .onConflictDoNothing()
    .returning();
  if (inserted) return inserted;
  const [raced] = await db
    .select()
    .from(dmContacts)
    .where(and(eq(dmContacts.ownerId, ownerId), eq(dmContacts.peerId, peerId)));
  return raced;
}

// 搜索并加入消息列表：命中即添加（只建自己的会话行）；未命中由 findUserByUsername 抛错
export async function addContactByUsername(actorId: string, rawName: string) {
  const user = await findUserByUsername(actorId, rawName);
  await ensureContact(actorId, user.id);
  return user;
}

// —— 会话列表 ——

export type DmConversation = {
  peerId: string;
  peerName: string;
  identity: UserIdentity | null;
  peerAvatarUrl: string | null;
  // 最近一条消息预览（文件消息为「[文件] 文件名」）；null=刚添加还没说过话
  preview: string | null;
  lastAt: string | null; // ISO
  lastMine: boolean; // 最近一条是否我发的
  unread: number;
};

export async function listConversations(actorId: string): Promise<DmConversation[]> {
  const contacts = await db
    .select({
      peerId: dmContacts.peerId,
      peerName: users.name,
      identity: users.identity,
      avatarUpdatedAt: users.avatarUpdatedAt,
      addedAt: dmContacts.createdAt,
    })
    .from(dmContacts)
    .innerJoin(users, eq(dmContacts.peerId, users.id))
    .where(eq(dmContacts.ownerId, actorId));
  if (contacts.length === 0) return [];

  // 我收发的全部消息（含附件名），倒序——JS 内每人取第一条即最近一条
  const msgs = await db
    .select({
      senderId: dmMessages.senderId,
      recipientId: dmMessages.recipientId,
      content: dmMessages.content,
      attachmentFilename: dmAttachments.filename,
      createdAt: dmMessages.createdAt,
    })
    .from(dmMessages)
    .leftJoin(dmAttachments, eq(dmMessages.attachmentId, dmAttachments.id))
    .where(or(eq(dmMessages.senderId, actorId), eq(dmMessages.recipientId, actorId)))
    .orderBy(desc(dmMessages.createdAt));

  const unreadRows = await db
    .select({ senderId: dmMessages.senderId, count: sql<number>`count(*)::int` })
    .from(dmMessages)
    .where(and(eq(dmMessages.recipientId, actorId), isNull(dmMessages.readAt)))
    .groupBy(dmMessages.senderId);
  const unreadBySender = new Map(unreadRows.map((r) => [r.senderId, r.count]));

  const latest = new Map<string, (typeof msgs)[number]>();
  for (const m of msgs) {
    const peer = m.senderId === actorId ? m.recipientId : m.senderId;
    if (!latest.has(peer)) latest.set(peer, m);
  }

  // 排序：最近消息时间倒序；还没说过话的按添加时间垫后
  return contacts
    .slice()
    .sort((a, b) => {
      const ta = latest.get(a.peerId)?.createdAt ?? a.addedAt;
      const tb = latest.get(b.peerId)?.createdAt ?? b.addedAt;
      return tb.getTime() - ta.getTime();
    })
    .map((c) => {
      const m = latest.get(c.peerId);
      return {
        peerId: c.peerId,
        peerName: c.peerName,
        identity: c.identity,
        peerAvatarUrl: userAvatarUrl(c.peerId, c.avatarUpdatedAt),
        preview: m ? (m.attachmentFilename ? `[文件] ${m.attachmentFilename}` : m.content) : null,
        lastAt: m ? m.createdAt.toISOString() : null,
        lastMine: m?.senderId === actorId,
        unread: unreadBySender.get(c.peerId) ?? 0,
      };
    });
}

// —— 会话内消息 ——

export type DmMessageView = {
  id: string;
  mine: boolean;
  content: string;
  readAt: string | null; // 我发的消息：对方是否已读
  createdAt: string;
  attachment: { id: string; filename: string; size: number } | null;
};

export async function listMessages(
  actorId: string,
  peerId: string,
): Promise<{ peer: DmPeer; messages: DmMessageView[] }> {
  const [peer] = await db
    .select({
      id: users.id,
      name: users.name,
      identity: users.identity,
      avatarUpdatedAt: users.avatarUpdatedAt,
    })
    .from(users)
    .where(eq(users.id, peerId));
  if (!peer) throw new AppError("用户不存在");
  await ensureContact(actorId, peerId);

  const rows = await db
    .select({
      id: dmMessages.id,
      senderId: dmMessages.senderId,
      content: dmMessages.content,
      readAt: dmMessages.readAt,
      createdAt: dmMessages.createdAt,
      attachmentId: dmAttachments.id,
      attachmentFilename: dmAttachments.filename,
      attachmentSize: dmAttachments.size,
    })
    .from(dmMessages)
    .leftJoin(dmAttachments, eq(dmMessages.attachmentId, dmAttachments.id))
    .where(
      or(
        and(eq(dmMessages.senderId, actorId), eq(dmMessages.recipientId, peerId)),
        and(eq(dmMessages.senderId, peerId), eq(dmMessages.recipientId, actorId)),
      ),
    )
    .orderBy(asc(dmMessages.createdAt));

  // 打开即已读：对方发我的未读消息批量置读，对方的未读角标与已读回执据此更新
  await db
    .update(dmMessages)
    .set({ readAt: sql`now()` })
    .where(
      and(
        eq(dmMessages.recipientId, actorId),
        eq(dmMessages.senderId, peerId),
        isNull(dmMessages.readAt),
      ),
    );

  return {
    peer: { ...peer, avatarUrl: userAvatarUrl(peer.id, peer.avatarUpdatedAt) },
    messages: rows.map((r) => ({
      id: r.id,
      mine: r.senderId === actorId,
      content: r.content,
      readAt: r.readAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      attachment: r.attachmentId
        ? {
            id: r.attachmentId,
            filename: r.attachmentFilename ?? "未命名文件",
            size: r.attachmentSize ?? 0,
          }
        : null,
    })),
  };
}

// —— 发送 ——

// 发私信（文本与文件至少其一）：附件与消息同事务落库，双方会话行一并补齐。
// 返回原始消息行（含 attachmentId），展示形状由调用方组装。
export async function sendDm(
  actorId: string,
  peerId: string,
  input: {
    content: string;
    file?: { filename: string; mimeType?: string | null; size: number; data: Buffer } | null;
  },
) {
  if (actorId === peerId) throw new AppError("不能给自己发消息");
  const [peer] = await db.select({ id: users.id }).from(users).where(eq(users.id, peerId));
  if (!peer) throw new AppError("用户不存在");

  // 文本截断到 5000 字符，防超长刷屏
  const content = input.content.trim().slice(0, 5000);
  const file = input.file;
  if (file) {
    if (file.size > DM_ATTACHMENT_MAX_SIZE) throw new AppError("文件不能超过 10MB");
    if (file.size === 0) throw new AppError("不能上传空文件");
  }
  if (!content && !file) throw new AppError("不能发送空消息");

  return db.transaction(async (tx) => {
    let attachmentId: string | null = null;
    if (file) {
      const [att] = await tx
        .insert(dmAttachments)
        .values({
          uploaderId: actorId,
          filename: file.filename.slice(0, 200) || "未命名文件",
          mimeType: file.mimeType ?? null,
          size: file.size,
          data: file.data,
        })
        .returning({ id: dmAttachments.id });
      attachmentId = att.id;
    }
    const [msg] = await tx
      .insert(dmMessages)
      .values({ senderId: actorId, recipientId: peerId, content, attachmentId })
      .returning();
    // 双方都出现在彼此的消息列表里
    await tx
      .insert(dmContacts)
      .values([
        { ownerId: actorId, peerId },
        { ownerId: peerId, peerId: actorId },
      ])
      .onConflictDoNothing();
    return msg;
  });
}

// —— 未读总数（导航角标用） ——

export async function countUnread(actorId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dmMessages)
    .where(and(eq(dmMessages.recipientId, actorId), isNull(dmMessages.readAt)));
  return row?.count ?? 0;
}

// —— 附件下载 ——

// 私信附件：收发双方可下载；群聊附件（dm_group_messages 引用）：群成员可下载。
// 内容随行返回，仅此路径取 data 列。群成员校验内联在此而非 lib/group-chat.ts——
// 那边 import 本文件的 findUserByUsername，反向引用会成环。
export async function getDmAttachmentForDownload(actorId: string, attachmentId: string) {
  const [dmRow] = await db
    .select({ senderId: dmMessages.senderId, recipientId: dmMessages.recipientId })
    .from(dmMessages)
    .where(eq(dmMessages.attachmentId, attachmentId));
  if (dmRow) {
    if (dmRow.senderId !== actorId && dmRow.recipientId !== actorId) throw new ForbiddenError();
  } else {
    const [groupRow] = await db
      .select({ groupId: dmGroupMessages.groupId })
      .from(dmGroupMessages)
      .where(eq(dmGroupMessages.attachmentId, attachmentId));
    if (!groupRow) throw new AppError("附件不存在");
    const [member] = await db
      .select({ userId: dmGroupMembers.userId })
      .from(dmGroupMembers)
      .where(
        and(eq(dmGroupMembers.groupId, groupRow.groupId), eq(dmGroupMembers.userId, actorId)),
      );
    if (!member) throw new ForbiddenError();
  }

  const [att] = await db
    .select({
      id: dmAttachments.id,
      filename: dmAttachments.filename,
      mimeType: dmAttachments.mimeType,
      size: dmAttachments.size,
      data: dmAttachments.data,
    })
    .from(dmAttachments)
    .where(eq(dmAttachments.id, attachmentId));
  if (!att) throw new AppError("附件不存在");
  return { ...att, senderId: null, recipientId: null };
}
