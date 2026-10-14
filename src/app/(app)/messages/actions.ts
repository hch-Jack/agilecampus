"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  addContactByUsername,
  countUnread,
  listConversations,
  listMessages,
  sendDm,
  type DmConversation,
  type DmMessageView,
  type DmPeer,
} from "@/lib/dm";

// 注意：本文件是 "use server"，只能导出异步函数——共享类型从 @/lib/dm 用 `import type`
// 引入即可（编译期擦除），切勿在此 `export type {}` 再导出，Turbopack 会把它编译成
// 运行时导出，模块求值即抛 ReferenceError（整个 (app) 组的页面都会崩）。

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
  return withUser(async (userId) => {
    const user = await addContactByUsername(userId, rawName);
    return { id: user.id, name: user.name, identity: user.identity };
  });
}

export async function getConversationsAction(): Promise<Result<DmConversation[]>> {
  return withUser((userId) => listConversations(userId));
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

// 导航栏未读角标
export async function getUnreadCountAction(): Promise<Result<number>> {
  return withUser((userId) => countUnread(userId));
}
