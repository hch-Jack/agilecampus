import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDmPeer } from "@/lib/dm";
import { getGroupInfo } from "@/lib/group-chat";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { MessagesClient, type MessageJumpTarget } from "./messages-client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * 助手「跳到某条消息」用的深链：`?dm=<peerId>&msg=<messageId>` 或
 * `?group=<groupId>&msg=<messageId>`。这里先做权限与形状校验，客户端拿到的是
 * 一个已经确认可打开的会话目标；校验失败就当没传，照常打开消息页。
 */
async function resolveJumpTarget(
  userId: string,
  searchParams: Record<string, string | string[] | undefined>,
): Promise<MessageJumpTarget | null> {
  const messageId = one(searchParams.msg);
  if (!messageId || !UUID_RE.test(messageId)) return null;

  const dmId = one(searchParams.dm);
  if (dmId && UUID_RE.test(dmId)) {
    try {
      const peer = await getDmPeer(userId, dmId);
      return { kind: "dm", id: dmId, messageId, peer };
    } catch {
      return null;
    }
  }

  const groupId = one(searchParams.group);
  if (groupId && UUID_RE.test(groupId)) {
    try {
      await getGroupInfo(userId, groupId);
      return { kind: "group", id: groupId, messageId };
    } catch {
      return null;
    }
  }

  return null;
}

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // 数据全走 client 轮询的 server action（会话列表 + 会话内消息），页面只做登录门禁；
  // 时区要在服务端定下来传给客户端 —— 客户端只知道浏览器时区，那不是用户的偏好
  const timeZone = await resolveUserTimeZone(session.user.id);
  const initialTarget = await resolveJumpTarget(session.user.id, await searchParams);
  return <MessagesClient timeZone={timeZone} initialTarget={initialTarget} />;
}
