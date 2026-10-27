"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth, signOut } from "@/lib/auth";
import {
  WORKBENCH_SCOPE,
  clearFeed,
  deleteActivityForUser,
  isFeedScopeValid,
  markFeedRead,
} from "@/lib/activity";
import { db } from "@/db";
import { tasks, users } from "@/db/schema";
import { anonymizeUser } from "@/lib/user";
import { verifyPassword } from "@/lib/password";

// 顶栏「设置」菜单里的「退出」：抽成共享 server action，
// 因为菜单是客户端组件，客户端组件里不能内联定义 "use server"。
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

// 「设置」菜单里「退出」下方的「注销账号」：经密码二次确认后匿名化当前账号。
// 匿名化（而非硬删）的原因见 lib/user.ts 的 anonymizeUser：用户在他人项目里的附件/动态
// 引用了 users.id 且非级联外键，硬删会撞外键；匿名化擦 PII、保外键、历史不丢，账号无法再登录。
// 成功后由调用方（user-menu 弹窗）调 signOutAction 登出回 /login。
export async function deleteAccountAction(
  password: string,
): Promise<{ ok: true } | { error: string }> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const [user] = await db
    .select({ passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, session.user.id));
  if (!user) return { error: "账号不存在" };
  if (!(await verifyPassword(password, user.passwordHash))) {
    return { error: "密码不正确" };
  }
  await anonymizeUser(session.user.id);
  return { ok: true };
}

// 「新手教程」首次自动弹出时即标记已看过（教程小窗是纯客户端的，看不看完无从也无须判定）。
// where 带 isNull：重复/并发调用幂等，绝不覆盖已有标记；未登录静默忽略。
export async function markTutorialSeenAction() {
  const session = await auth();
  if (!session?.user) return;
  await db
    .update(users)
    .set({ tutorialSeenAt: sql`now()` })
    .where(and(eq(users.id, session.user.id), isNull(users.tutorialSeenAt)));
}

// 「最新记录」模块点「标记已读」时由客户端调用的动作。
// scope 白名单校验防脏数据行；未登录静默忽略——客户端乐观清角标，失败无感。
export async function markFeedReadAction(scope: string) {
  const session = await auth();
  if (!session?.user || !isFeedScopeValid(scope)) return;
  await markFeedRead(session.user.id, scope);
}

/** 动态流 scope → 对应页面路径的 revalidate；任务页路径带 projectId，需按 taskId 反查 */
async function revalidateFeedScope(scope: string): Promise<void> {
  if (scope === WORKBENCH_SCOPE) {
    revalidatePath("/dashboard");
  } else if (scope.startsWith("project:")) {
    revalidatePath(`/projects/${scope.slice("project:".length)}`);
  } else {
    // task: 任务已删则该页本就不存在，跳过
    const taskId = scope.slice("task:".length);
    const [task] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    if (task) revalidatePath(`/projects/${task.projectId}/tasks/${taskId}`);
  }
}

export type ClearRecordsState = { error: string } | null;

// 「清除记录」：只清空当前用户自己看到的动态流（工作台或某项目页），库内数据与他人视图不动，
// 因此人人可用、无需项目权限校验，scope 白名单校验防脏数据行即可。
export async function clearFeedAction(scope: string): Promise<ClearRecordsState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!isFeedScopeValid(scope)) return { error: "参数无效" };

  await clearFeed(session.user.id, scope);
  await revalidateFeedScope(scope);
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeleteActivityResult =
  | { ok: true; mode: "all" | "self" }
  | { error: string };

/**
 * 删除单条动态（scope 只用于判断回流哪个页面）。
 * 权限与「删本人 / 删全局」的判定全在 `deleteActivityForUser`：
 * 团队管理员删库、其他成员只隐藏自己的视图。
 */
export async function deleteActivityAction(
  activityId: string,
  scope: string,
): Promise<DeleteActivityResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!UUID_RE.test(activityId) || !isFeedScopeValid(scope)) return { error: "参数无效" };

  try {
    const mode = await deleteActivityForUser(session.user.id, activityId);
    await revalidateFeedScope(scope);
    return { ok: true, mode };
  } catch {
    return { error: "删除失败，请稍后再试" };
  }
}
