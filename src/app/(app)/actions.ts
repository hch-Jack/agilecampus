"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import {
  clearProjectActivities,
  isFeedScopeValid,
  markFeedRead,
} from "@/lib/activity";
import { AppError, ForbiddenError } from "@/lib/errors";

// 「最新记录」模块翻到最新一条时由客户端（IntersectionObserver）调用的标记已读动作。
// scope 白名单校验防脏数据行；未登录静默忽略——客户端乐观清角标，失败无感。
export async function markFeedReadAction(scope: string) {
  const session = await auth();
  if (!session?.user || !isFeedScopeValid(scope)) return;
  await markFeedRead(session.user.id, scope);
}

export type ClearRecordsState = { error: string } | null;

// 项目页「清除记录」：仅项目管理员可清空该项目全部动态（任务本身不动）。
export async function clearProjectActivitiesAction(projectId: string): Promise<ClearRecordsState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!z.uuid().safeParse(projectId).success) return { error: "参数无效" };

  try {
    await clearProjectActivities(session.user.id, projectId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "仅项目管理员可清除记录" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${projectId}`);
  return null;
}
