import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, tasks, users } from "@/db/schema";
import { sendDm } from "./dm";

/**
 * @ 提醒通知：留言发表后，向被 @ 的成员各发一条私信，正文注明来自哪个项目/任务的留言板。
 *
 * 三条工程补丁在此收口：
 *  · 自 @ 过滤：剔除 actorId 本人——sendDm 禁止自发自收，留在 targets 里会让每条都报错。
 *  · 并发分发：Promise.allSettled 同时发出，不串行 await（多人 @ 时串行会拖慢留言发表）。
 *  · 错误隔离：单条 DM 失败（对端不存在等）只记日志、不影响其余；发送环节不因单条失败而抛错。
 *    调用方（server action）仍把本调用包在独立 try-catch 里兜底，确保通知任何异常都不阻塞留言落库。
 */
export async function notifyMentionedUsers(input: {
  actorId: string;
  mentionedUserIds: string[];
  scope: "task" | "project";
  projectId: string;
  /** scope="task" 时必填：定位任务标题，写进私信正文 */
  taskId?: string;
  /** 留言正文，作为私信内容的引用部分 */
  content: string;
}): Promise<void> {
  // 自 @ 过滤 + 去重
  const targets = [...new Set(input.mentionedUserIds)].filter((id) => id !== input.actorId);
  if (targets.length === 0) return;

  // 解析展示名：发件人、项目（、任务）。任一查不到都回落友好占位，不阻断发送。
  const [authorRows, projectRows] = await Promise.all([
    db.select({ name: users.name }).from(users).where(eq(users.id, input.actorId)),
    db.select({ name: projects.name }).from(projects).where(eq(projects.id, input.projectId)),
  ]);
  const authorName = authorRows[0]?.name ?? "未知用户";
  const projectName = projectRows[0]?.name ?? "未知项目";

  let taskTitle: string | null = null;
  if (input.scope === "task" && input.taskId) {
    const [taskRow] = await db
      .select({ title: tasks.title })
      .from(tasks)
      .where(eq(tasks.id, input.taskId));
    taskTitle = taskRow?.title ?? null;
  }

  const whereFrom =
    input.scope === "task"
      ? `「${projectName}」· 任务「${taskTitle ?? "未知任务"}」留言板`
      : `「${projectName}」· 项目留言板`;
  const message = `${authorName} @ 了你（${whereFrom}）：\n\n${input.content}`;

  // 并发分发：allSettled 保证单条失败不抛错；逐条记日志便于排查
  const results = await Promise.allSettled(
    targets.map((peerId) => sendDm(input.actorId, peerId, { content: message })),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(
        `[mention] DM to ${targets[i]} failed (actor=${input.actorId}, scope=${input.scope}, projectId=${input.projectId}):`,
        r.reason,
      );
    }
  });
}
