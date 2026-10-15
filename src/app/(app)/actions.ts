"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { auth, signOut } from "@/lib/auth";
import { clearFeed, isFeedScopeValid, markFeedRead } from "@/lib/activity";
import { db } from "@/db";
import { tasks } from "@/db/schema";

// 顶栏「设置」菜单里的「退出」：抽成共享 server action，
// 因为菜单是客户端组件，客户端组件里不能内联定义 "use server"。
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}

// 「最新记录」模块点「标记已读」时由客户端调用的动作。
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

  if (scope === "workbench") {
    revalidatePath("/dashboard");
  } else if (scope.startsWith("project:")) {
    revalidatePath(`/projects/${scope.slice("project:".length)}`);
  } else {
    // task: 任务页路径带 projectId，按 taskId 反查；任务已删则该页本就不存在，跳过
    const taskId = scope.slice("task:".length);
    const [task] = await db
      .select({ projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    if (task) revalidatePath(`/projects/${task.projectId}/tasks/${taskId}`);
  }
  return null;
}
