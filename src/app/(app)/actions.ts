"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { clearFeed, isFeedScopeValid, markFeedRead } from "@/lib/activity";

// 「最新记录」模块翻到最新一条时由客户端（IntersectionObserver）调用的标记已读动作。
// scope 白名单校验防脏数据行；未登录静默忽略——客户端乐观清角标，失败无感。
export async function markFeedReadAction(scope: string) {
  const session = await auth();
  if (!session?.user || !isFeedScopeValid(scope)) return;
  await markFeedRead(session.user.id, scope);
}

export type ClearRecordsState = { error: string } | null;

// 「清除记录」：只清空当前用户自己看到的动态流（工作台或某项目页），库内数据与他人视图不动，
// 因此人人可用、无需项目权限校验，scope 白名单校验防脏数据行即可。
export async function clearFeedAction(scope: string): Promise<ClearRecordsState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!isFeedScopeValid(scope)) return { error: "参数无效" };

  await clearFeed(session.user.id, scope);

  revalidatePath("/dashboard");
  if (scope.startsWith("project:")) {
    revalidatePath(`/projects/${scope.slice("project:".length)}`);
  }
  return null;
}
