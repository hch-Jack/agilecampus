import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dmAttachments,
  dmGroupInvites,
  dmGroupMembers,
  dmGroupMessages,
  dmGroups,
  users,
  type UserIdentity,
} from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
// 单向依赖 dm.ts：复用用户名搜索与附件上限；dm.ts 不得反向 import 本文件（会成环）
import { DM_ATTACHMENT_MAX_SIZE, findUserByUsername, type DmConversation } from "./dm";

// 群名长度与群规模上限（含群主）；打开会话只回最近 N 条，避免老群越聊越重
export const GROUP_NAME_MAX = 30;
export const GROUP_MEMBER_CAP = 50;
export const GROUP_MESSAGE_FETCH_LIMIT = 200;

// —— 视图类型（供 actions / 客户端 `import type`；类型不得放在 "use server" 文件里）——

export type GroupMemberView = {
  userId: string;
  name: string;
  identity: UserIdentity | null;
  joinedAt: string; // ISO
};

export type GroupInfo = {
  id: string;
  name: string;
  ownerId: string;
  amOwner: boolean;
  memberCount: number;
  // joinedAt 升序——群主即最早入群者，天然排第一
  members: GroupMemberView[];
};

export type GroupMessageView = {
  id: string;
  senderId: string;
  senderName: string;
  mine: boolean;
  content: string;
  createdAt: string;
  attachment: { id: string; filename: string; size: number } | null;
  // 刻意没有 readAt：群聊无已读回执，已读状态只在成员表的 lastReadAt 上
};

export type GroupConversation = {
  kind: "group";
  groupId: string;
  name: string;
  memberCount: number;
  // 最近一条消息预览（文件消息为「[文件] 文件名」）；null=建群后还没人说过话
  preview: string | null;
  lastAt: string | null; // ISO
  lastMine: boolean; // 最近一条是否我发的
  lastSenderName: string | null;
  unread: number;
};

export type GroupInviteView = {
  inviteId: string;
  groupId: string;
  groupName: string;
  inviterName: string;
  createdAt: string; // ISO
};

// 消息页左栏统一会话行：私信行带 kind:"dm"（DmConversation 的超集），群行 kind:"group"
export type UnifiedConversation = ({ kind: "dm" } & DmConversation) | GroupConversation;

// —— 建群 ——

export async function createGroup(
  actorId: string,
  rawName: string,
  memberIds: string[],
): Promise<GroupInfo> {
  const name = rawName.trim();
  if (!name) throw new AppError("请输入群聊名称");
  if (name.length > GROUP_NAME_MAX) throw new AppError(`群名称不能超过 ${GROUP_NAME_MAX} 个字`);
  // 去重并剔除自己（群主天然是成员，选人列表里误勾自己不报错）
  const ids = [...new Set(memberIds.filter((id) => id !== actorId))];
  if (ids.length + 1 > GROUP_MEMBER_CAP) throw new AppError(`群成员最多 ${GROUP_MEMBER_CAP} 人`);
  if (ids.length > 0) {
    const found = await db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    if (found.length !== ids.length) throw new AppError("邀请的成员不存在");
  }

  const groupId = await db.transaction(async (tx) => {
    const [group] = await tx
      .insert(dmGroups)
      .values({ name, ownerId: actorId })
      .returning({ id: dmGroups.id });
    // lastReadAt/joinedAt 用列默认值（DB 时钟 now()），入群即刻起算未读基线
    await tx.insert(dmGroupMembers).values([
      { groupId: group.id, userId: actorId },
      ...ids.map((userId) => ({ groupId: group.id, userId })),
    ]);
    return group.id;
  });
  return getGroupInfo(actorId, groupId);
}

// —— 成员与群信息 ——

// 成员守卫：open/send/invite 共用。被踢或群解散后再操作都从这里拦下
async function requireMembership(groupId: string, userId: string) {
  const [member] = await db
    .select({ userId: dmGroupMembers.userId })
    .from(dmGroupMembers)
    .where(and(eq(dmGroupMembers.groupId, groupId), eq(dmGroupMembers.userId, userId)));
  if (!member) throw new ForbiddenError("你已不在该群聊中");
}

export async function getGroupInfo(actorId: string, groupId: string): Promise<GroupInfo> {
  const [group] = await db
    .select({ id: dmGroups.id, name: dmGroups.name, ownerId: dmGroups.ownerId })
    .from(dmGroups)
    .where(eq(dmGroups.id, groupId));
  if (!group) throw new AppError("群聊不存在或已解散");
  await requireMembership(groupId, actorId);

  const rows = await db
    .select({
      userId: dmGroupMembers.userId,
      name: users.name,
      identity: users.identity,
      joinedAt: dmGroupMembers.joinedAt,
    })
    .from(dmGroupMembers)
    .innerJoin(users, eq(dmGroupMembers.userId, users.id))
    .where(eq(dmGroupMembers.groupId, groupId))
    .orderBy(asc(dmGroupMembers.joinedAt));

  return {
    id: group.id,
    name: group.name,
    ownerId: group.ownerId,
    amOwner: group.ownerId === actorId,
    memberCount: rows.length,
    members: rows.map((r) => ({
      userId: r.userId,
      name: r.name,
      identity: r.identity,
      joinedAt: r.joinedAt.toISOString(),
    })),
  };
}

// —— 邀请（行存在即待处理）——

export async function inviteToGroup(actorId: string, groupId: string, rawName: string) {
  await requireMembership(groupId, actorId);
  const invitee = await findUserByUsername(actorId, rawName);

  const [existingMember] = await db
    .select({ userId: dmGroupMembers.userId })
    .from(dmGroupMembers)
    .where(and(eq(dmGroupMembers.groupId, groupId), eq(dmGroupMembers.userId, invitee.id)));
  if (existingMember) throw new AppError("TA 已在群聊里");

  const [pending] = await db
    .select({ id: dmGroupInvites.id })
    .from(dmGroupInvites)
    .where(and(eq(dmGroupInvites.groupId, groupId), eq(dmGroupInvites.inviteeId, invitee.id)));
  if (pending) throw new AppError("已邀请过，等待对方处理");

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dmGroupMembers)
    .where(eq(dmGroupMembers.groupId, groupId));
  if (count >= GROUP_MEMBER_CAP) throw new AppError(`群成员已满（上限 ${GROUP_MEMBER_CAP} 人）`);

  const [inserted] = await db
    .insert(dmGroupInvites)
    .values({ groupId, inviterId: actorId, inviteeId: invitee.id })
    .onConflictDoNothing()
    .returning({ id: dmGroupInvites.id });
  // 并发兜底：唯一索引 (groupId, inviteeId) 挡下重复邀请
  if (!inserted) throw new AppError("已邀请过，等待对方处理");
  return { inviteeName: invitee.name };
}

export async function listMyGroupInvites(actorId: string): Promise<GroupInviteView[]> {
  const rows = await db
    .select({
      inviteId: dmGroupInvites.id,
      groupId: dmGroupInvites.groupId,
      groupName: dmGroups.name,
      inviterName: users.name,
      createdAt: dmGroupInvites.createdAt,
    })
    .from(dmGroupInvites)
    .innerJoin(dmGroups, eq(dmGroupInvites.groupId, dmGroups.id))
    .innerJoin(users, eq(dmGroupInvites.inviterId, users.id))
    .where(eq(dmGroupInvites.inviteeId, actorId))
    .orderBy(desc(dmGroupInvites.createdAt));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

// 接受/拒绝：事务内先用 DELETE（限定 id + 本人）把邀请「认领」掉——
// 双击或并发二次响应删不到行，自然报「邀请不存在或已处理」。
// 满员时抛错会连带回滚 DELETE，邀请留在列表里，用户仍可选择拒绝。
export async function respondToGroupInvite(actorId: string, inviteId: string, accept: boolean) {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .delete(dmGroupInvites)
      .where(and(eq(dmGroupInvites.id, inviteId), eq(dmGroupInvites.inviteeId, actorId)))
      .returning({ groupId: dmGroupInvites.groupId });
    if (!claimed) throw new AppError("邀请不存在或已处理");

    const [group] = await tx
      .select({ id: dmGroups.id, name: dmGroups.name })
      .from(dmGroups)
      .where(eq(dmGroups.id, claimed.groupId));
    if (!group) throw new AppError("群聊不存在或已解散");
    if (!accept) return { groupId: group.id, groupName: group.name };

    // 接受前复查规模：处理邀请期间群可能被别人填满
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(dmGroupMembers)
      .where(eq(dmGroupMembers.groupId, group.id));
    if (count >= GROUP_MEMBER_CAP) throw new AppError(`群成员已满（上限 ${GROUP_MEMBER_CAP} 人）`);
    await tx
      .insert(dmGroupMembers)
      .values({ groupId: group.id, userId: actorId })
      .onConflictDoNothing();
    return { groupId: group.id, groupName: group.name };
  });
}

// —— 会话列表与未读 ——

export async function listGroupConversations(actorId: string): Promise<GroupConversation[]> {
  const memberships = await db
    .select({
      groupId: dmGroupMembers.groupId,
      name: dmGroups.name,
      joinedAt: dmGroupMembers.joinedAt,
    })
    .from(dmGroupMembers)
    .innerJoin(dmGroups, eq(dmGroupMembers.groupId, dmGroups.id))
    .where(eq(dmGroupMembers.userId, actorId));
  if (memberships.length === 0) return [];
  const groupIds = memberships.map((m) => m.groupId);

  // 各群全部消息（含发送人名与附件名），倒序——JS 内每群取第一条即最近一条。
  // 群多了这里会是第一个要换 DISTINCT ON / 窗口函数的点（私信列表同款取法）。
  const msgs = await db
    .select({
      groupId: dmGroupMessages.groupId,
      senderId: dmGroupMessages.senderId,
      senderName: users.name,
      content: dmGroupMessages.content,
      attachmentFilename: dmAttachments.filename,
      createdAt: dmGroupMessages.createdAt,
    })
    .from(dmGroupMessages)
    .innerJoin(users, eq(dmGroupMessages.senderId, users.id))
    .leftJoin(dmAttachments, eq(dmGroupMessages.attachmentId, dmAttachments.id))
    .where(inArray(dmGroupMessages.groupId, groupIds))
    .orderBy(desc(dmGroupMessages.createdAt));

  // 未读：lastReadAt 之后**别人**发的消息。created_at 与 last_read_at 两列在 PG 内直接
  // 比较（同为会话时区钟面），任何时区口径下都自洽
  const unreadRows = await db
    .select({ groupId: dmGroupMessages.groupId, count: sql<number>`count(*)::int` })
    .from(dmGroupMessages)
    .innerJoin(
      dmGroupMembers,
      and(
        eq(dmGroupMembers.groupId, dmGroupMessages.groupId),
        eq(dmGroupMembers.userId, actorId),
      ),
    )
    .where(
      and(
        sql`${dmGroupMessages.createdAt} > ${dmGroupMembers.lastReadAt}`,
        sql`${dmGroupMessages.senderId} <> ${actorId}`,
      ),
    )
    .groupBy(dmGroupMessages.groupId);

  const countRows = await db
    .select({ groupId: dmGroupMembers.groupId, count: sql<number>`count(*)::int` })
    .from(dmGroupMembers)
    .where(inArray(dmGroupMembers.groupId, groupIds))
    .groupBy(dmGroupMembers.groupId);

  const latest = new Map<string, (typeof msgs)[number]>();
  for (const m of msgs) {
    if (!latest.has(m.groupId)) latest.set(m.groupId, m);
  }
  const unreadByGroup = new Map(unreadRows.map((r) => [r.groupId, r.count]));
  const countByGroup = new Map(countRows.map((r) => [r.groupId, r.count]));

  // 排序：最近消息时间倒序；还没人说过话的按入群时间垫后（与私信列表同一规则）
  return memberships
    .slice()
    .sort((a, b) => {
      const ta = latest.get(a.groupId)?.createdAt ?? a.joinedAt;
      const tb = latest.get(b.groupId)?.createdAt ?? b.joinedAt;
      return tb.getTime() - ta.getTime();
    })
    .map((m) => {
      const msg = latest.get(m.groupId);
      return {
        kind: "group" as const,
        groupId: m.groupId,
        name: m.name,
        memberCount: countByGroup.get(m.groupId) ?? 1,
        preview: msg
          ? msg.attachmentFilename
            ? `[文件] ${msg.attachmentFilename}`
            : msg.content
          : null,
        lastAt: msg ? msg.createdAt.toISOString() : null,
        lastMine: msg?.senderId === actorId,
        lastSenderName: msg?.senderName ?? null,
        unread: unreadByGroup.get(m.groupId) ?? 0,
      };
    });
}

export async function countGroupUnread(actorId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dmGroupMessages)
    .innerJoin(
      dmGroupMembers,
      and(
        eq(dmGroupMembers.groupId, dmGroupMessages.groupId),
        eq(dmGroupMembers.userId, actorId),
      ),
    )
    .where(
      and(
        sql`${dmGroupMessages.createdAt} > ${dmGroupMembers.lastReadAt}`,
        sql`${dmGroupMessages.senderId} <> ${actorId}`,
      ),
    );
  return row?.count ?? 0;
}

export async function countPendingGroupInvites(actorId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dmGroupInvites)
    .where(eq(dmGroupInvites.inviteeId, actorId));
  return row?.count ?? 0;
}

// —— 会话内消息 ——

export async function openGroupConversation(
  actorId: string,
  groupId: string,
): Promise<{ group: GroupInfo; messages: GroupMessageView[] }> {
  const group = await getGroupInfo(actorId, groupId);

  const rows = await db
    .select({
      id: dmGroupMessages.id,
      senderId: dmGroupMessages.senderId,
      senderName: users.name,
      content: dmGroupMessages.content,
      createdAt: dmGroupMessages.createdAt,
      attachmentId: dmAttachments.id,
      attachmentFilename: dmAttachments.filename,
      attachmentSize: dmAttachments.size,
    })
    .from(dmGroupMessages)
    .innerJoin(users, eq(dmGroupMessages.senderId, users.id))
    .leftJoin(dmAttachments, eq(dmGroupMessages.attachmentId, dmAttachments.id))
    .where(eq(dmGroupMessages.groupId, groupId))
    .orderBy(desc(dmGroupMessages.createdAt))
    .limit(GROUP_MESSAGE_FETCH_LIMIT);

  // 打开即已读：未读基线推到 DB 当前时刻（幂等，谁打开谁推自己的）
  await db
    .update(dmGroupMembers)
    .set({ lastReadAt: sql`now()` })
    .where(and(eq(dmGroupMembers.groupId, groupId), eq(dmGroupMembers.userId, actorId)));

  return {
    group,
    // 倒序取最近 200 条再反转回正序（asc + 大偏移才是贵的取法）
    messages: rows.reverse().map((r) => ({
      id: r.id,
      senderId: r.senderId,
      senderName: r.senderName,
      mine: r.senderId === actorId,
      content: r.content,
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

// 发群消息（文本与文件至少其一），校验口径与 sendDm 完全一致：附件复用 dm_attachments
// 与同一 10MB 上限常量，文本截断到 5000 字符。
export async function sendGroupMessage(
  actorId: string,
  groupId: string,
  input: {
    content: string;
    file?: { filename: string; mimeType?: string | null; size: number; data: Buffer } | null;
  },
) {
  await requireMembership(groupId, actorId);

  const content = input.content.trim().slice(0, 5000);
  const file = input.file;
  if (file) {
    if (file.size > DM_ATTACHMENT_MAX_SIZE) throw new AppError("文件不能超过 10MB");
    if (file.size === 0) throw new AppError("不能上传空文件");
  }
  if (!content && !file) throw new AppError("不能发送空消息");

  await db.transaction(async (tx) => {
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
    await tx.insert(dmGroupMessages).values({ groupId, senderId: actorId, content, attachmentId });
  });
}

// —— 成员操作 ——

export async function leaveGroup(actorId: string, groupId: string) {
  const [group] = await db
    .select({ ownerId: dmGroups.ownerId })
    .from(dmGroups)
    .where(eq(dmGroups.id, groupId));
  if (!group) throw new AppError("群聊不存在或已解散");
  if (group.ownerId === actorId) throw new AppError("群主不能退群，如需退出请解散群聊");
  const [deleted] = await db
    .delete(dmGroupMembers)
    .where(and(eq(dmGroupMembers.groupId, groupId), eq(dmGroupMembers.userId, actorId)))
    .returning({ id: dmGroupMembers.id });
  if (!deleted) throw new AppError("你已不在该群聊中");
}

export async function kickMember(actorId: string, groupId: string, targetUserId: string) {
  const [group] = await db
    .select({ ownerId: dmGroups.ownerId })
    .from(dmGroups)
    .where(eq(dmGroups.id, groupId));
  if (!group) throw new AppError("群聊不存在或已解散");
  if (group.ownerId !== actorId) throw new ForbiddenError("只有群主才能移除成员");
  if (targetUserId === group.ownerId) throw new AppError("不能移除群主");
  const [deleted] = await db
    .delete(dmGroupMembers)
    .where(and(eq(dmGroupMembers.groupId, groupId), eq(dmGroupMembers.userId, targetUserId)))
    .returning({ id: dmGroupMembers.id });
  if (!deleted) throw new AppError("TA 已不在群聊中");
}

// 解散即删群行，成员/消息/邀请随 cascade 清掉；消息引用过的附件 blob 留档
// （与私信附件「无删除入口」同一口径）
export async function dissolveGroup(actorId: string, groupId: string) {
  const [group] = await db
    .select({ ownerId: dmGroups.ownerId })
    .from(dmGroups)
    .where(eq(dmGroups.id, groupId));
  if (!group) throw new AppError("群聊不存在或已解散");
  if (group.ownerId !== actorId) throw new ForbiddenError("只有群主才能解散群聊");
  await db.delete(dmGroups).where(eq(dmGroups.id, groupId));
}
