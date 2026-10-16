"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  addContactByUsername,
  countUnread,
  findUserByUsername,
  listConversations,
  listMessages,
  sendDm,
  type DmMessageView,
  type DmPeer,
} from "@/lib/dm";
import {
  countGroupUnread,
  countPendingGroupInvites,
  createGroup,
  dissolveGroup,
  inviteToGroup,
  kickMember,
  leaveGroup,
  listGroupConversations,
  listMyGroupInvites,
  openGroupConversation,
  respondToGroupInvite,
  sendGroupMessage,
  type GroupInfo,
  type GroupInviteView,
  type GroupMessageView,
  type UnifiedConversation,
} from "@/lib/group-chat";

// 注意：本文件是 "use server"，只能导出异步函数——共享类型从 @/lib/dm、@/lib/group-chat
// 用 `import type` 引入即可（编译期擦除），切勿在此 `export type {}` 再导出，Turbopack 会
// 把它编译成运行时导出，模块求值即抛 ReferenceError（整个 (app) 组的页面都会崩）。

// 客户端动作统一返回 { ok, data | error }：AppError 转可展示文案，其余异常原样抛给 Next
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function withUser<T>(fn: (userId: string) => Promise<T>): Promise<Result<T>> {
  const session = await auth();
  if (!session?.user) return { ok: false, error: "请先登录" };
  try {
    return { ok: true, data: await fn(session.user.id) };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, error: e.message };
    throw e;
  }
}

// 搜用户名加会话：命中 → 加入消息列表并返回对方；未命中 → error（前端提示重输）
export async function searchAddUserAction(rawName: string): Promise<Result<DmPeer>> {
  return withUser(async (userId) => addContactByUsername(userId, rawName));
}

// 建群选人时的用户名搜索：只找人，不建私信会话行（与 searchAddUserAction 的差异所在）
export async function findUserForGroupAction(rawName: string): Promise<Result<DmPeer>> {
  return withUser(async (userId) => {
    const user = await findUserByUsername(userId, rawName);
    // findUserByUsername 现在顺带回头像地址，建群选人列表与私信一致地显示
    return { id: user.id, name: user.name, identity: user.identity, avatarUrl: user.avatarUrl };
  });
}

export async function getConversationsAction(): Promise<Result<UnifiedConversation[]>> {
  return withUser(async (userId) => {
    const [dms, groups] = await Promise.all([
      listConversations(userId),
      listGroupConversations(userId),
    ]);
    const dmRows: UnifiedConversation[] = dms.map((c) => ({ kind: "dm" as const, ...c }));
    const groupRows: UnifiedConversation[] = groups;
    const withMsgs = [...dmRows, ...groupRows]
      .filter((c) => c.lastAt !== null)
      .sort((a, b) => (b.lastAt! > a.lastAt! ? 1 : -1));
    const silent = [...dmRows, ...groupRows].filter((c) => c.lastAt === null);
    return [...withMsgs, ...silent];
  });
}

export async function getUnreadCountAction(): Promise<Result<number>> {
  return withUser(async (userId) => {
    const [dm, group, invites] = await Promise.all([
      countUnread(userId),
      countGroupUnread(userId),
      countPendingGroupInvites(userId),
    ]);
    return dm + group + invites;
  });
}

// 打开会话：返回对方信息 + 全量历史（发过的、收过的都在），并把对方发我的未读置为已读
export async function openConversationAction(peerId: string): Promise<
  Result<{ peer: DmPeer; messages: DmMessageView[] }>
> {
  const parsed = z.uuid().safeParse(peerId);
  if (!parsed.success) return { ok: false, error: "用户不存在" };
  return withUser(async (userId) => {
    const { peer, messages } = await listMessages(userId, peerId);
    return { peer, messages };
  });
}

// 发消息（文本与文件至少其一）。发送成功返回全量消息，客户端直接整表替换。
export async function sendMessageAction(
  peerId: string,
  formData: FormData,
): Promise<Result<{ peer: DmPeer; messages: DmMessageView[] }>> {
  return withUser(async (userId) => {
    const content = String(formData.get("content") ?? "");
    const entry = formData.get("file");
    const file =
      entry instanceof File && entry.size > 0
        ? {
            filename: entry.name,
            mimeType: entry.type || null,
            size: entry.size,
            data: Buffer.from(await entry.arrayBuffer()),
          }
        : null;
    await sendDm(userId, peerId, { content, file });
    return listMessages(userId, peerId);
  });
}

// —— 群聊 ——

const groupIdSchema = z.uuid();
const fail = (error: string) => ({ ok: false as const, error });

export async function createGroupAction(
  name: string,
  memberIds: string[],
): Promise<Result<GroupInfo>> {
  const parsed = z.array(z.uuid()).max(49).safeParse(memberIds);
  if (!parsed.success) return fail("邀请的成员不存在");
  return withUser((userId) => createGroup(userId, name, parsed.data));
}

export async function listMyGroupInvitesAction(): Promise<Result<GroupInviteView[]>> {
  return withUser((userId) => listMyGroupInvites(userId));
}

export async function respondToGroupInviteAction(
  inviteId: string,
  accept: boolean,
): Promise<Result<{ groupId: string; groupName: string }>> {
  const parsed = z.uuid().safeParse(inviteId);
  if (!parsed.success) return fail("邀请不存在或已处理");
  return withUser((userId) => respondToGroupInvite(userId, parsed.data, accept));
}

export async function openGroupConversationAction(
  groupId: string,
): Promise<Result<{ group: GroupInfo; messages: GroupMessageView[] }>> {
  const parsed = groupIdSchema.safeParse(groupId);
  if (!parsed.success) return fail("群聊不存在或已解散");
  return withUser((userId) => openGroupConversation(userId, parsed.data));
}

// 群里发消息：与 sendMessageAction 同构——发送成功返回全量消息，客户端直接整表替换。
export async function sendGroupMessageAction(
  groupId: string,
  formData: FormData,
): Promise<Result<{ group: GroupInfo; messages: GroupMessageView[] }>> {
  const parsed = groupIdSchema.safeParse(groupId);
  if (!parsed.success) return fail("群聊不存在或已解散");
  return withUser(async (userId) => {
    const content = String(formData.get("content") ?? "");
    const entry = formData.get("file");
    const file =
      entry instanceof File && entry.size > 0
        ? {
            filename: entry.name,
            mimeType: entry.type || null,
            size: entry.size,
            data: Buffer.from(await entry.arrayBuffer()),
          }
        : null;
    await sendGroupMessage(userId, parsed.data, { content, file });
    return openGroupConversation(userId, parsed.data);
  });
}

export async function inviteToGroupAction(
  groupId: string,
  rawName: string,
): Promise<Result<{ inviteeName: string }>> {
  const parsed = groupIdSchema.safeParse(groupId);
  if (!parsed.success) return fail("群聊不存在或已解散");
  return withUser((userId) => inviteToGroup(userId, parsed.data, rawName));
}

export async function leaveGroupAction(groupId: string): Promise<Result<null>> {
  const parsed = groupIdSchema.safeParse(groupId);
  if (!parsed.success) return fail("群聊不存在或已解散");
  return withUser(async (userId) => {
    await leaveGroup(userId, parsed.data);
    return null;
  });
}

export async function kickMemberAction(
  groupId: string,
  targetUserId: string,
): Promise<Result<null>> {
  const parsed = z.array(groupIdSchema).length(2).safeParse([groupId, targetUserId]);
  if (!parsed.success) return fail("TA 已不在群聊中");
  return withUser(async (userId) => {
    await kickMember(userId, parsed.data[0], parsed.data[1]);
    return null;
  });
}

export async function dissolveGroupAction(groupId: string): Promise<Result<null>> {
  const parsed = groupIdSchema.safeParse(groupId);
  if (!parsed.success) return fail("群聊不存在或已解散");
  return withUser(async (userId) => {
    await dissolveGroup(userId, parsed.data);
    return null;
  });
}
