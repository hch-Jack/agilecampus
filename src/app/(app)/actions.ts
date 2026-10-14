"use server";

import { auth } from "@/lib/auth";
import { isFeedScopeValid, markFeedRead } from "@/lib/activity";

// 「最新记录」模块翻到最新一条时由客户端（IntersectionObserver）调用的标记已读动作。
// scope 白名单校验防脏数据行；未登录静默忽略——客户端乐观清角标，失败无感。
export async function markFeedReadAction(scope: string) {
  const session = await auth();
  if (!session?.user || !isFeedScopeValid(scope)) return;
  await markFeedRead(session.user.id, scope);
}
