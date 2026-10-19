import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { taskComments, tasks, users } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser } from "./project";

export async function listTaskComments(userId: string, taskId: string) {
  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");

  const access = await getProjectForUser(userId, task.projectId);
  if (!access) throw new ForbiddenError();

  const rows = await db
    .select({
      id: taskComments.id,
      content: taskComments.content,
      createdAt: taskComments.createdAt,
      authorId: taskComments.authorId,
      authorName: users.name,
    })
    .from(taskComments)
    .innerJoin(users, eq(taskComments.authorId, users.id))
    .where(eq(taskComments.taskId, taskId))
    .orderBy(asc(taskComments.createdAt));

  return rows;
}

export type ProjectCommentRow = {
  id: string;
  taskId: string;
  taskTitle: string;
  authorName: string;
  content: string;
  createdAt: Date;
};

/**
 * 项目级留言板：跨任务聚合，最新在前（任务页的单任务时间线仍用上面的正序版本）。
 * 助手读留言、以及将来项目页做「全部留言」都走这里，权限口径与任务留言一致。
 */
export async function listProjectComments(
  actorId: string,
  projectId: string,
  options: { taskId?: string; limit?: number } = {},
): Promise<ProjectCommentRow[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);

  if (options.taskId) {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, options.taskId), eq(tasks.projectId, projectId)));
    if (!task) throw new AppError("任务不属于该项目");
  }

  return db
    .select({
      id: taskComments.id,
      taskId: tasks.id,
      taskTitle: tasks.title,
      authorName: users.name,
      content: taskComments.content,
      createdAt: taskComments.createdAt,
    })
    .from(taskComments)
    .innerJoin(tasks, eq(taskComments.taskId, tasks.id))
    .innerJoin(users, eq(taskComments.authorId, users.id))
    .where(
      and(
        eq(tasks.projectId, projectId),
        ...(options.taskId ? [eq(taskComments.taskId, options.taskId)] : []),
      ),
    )
    // 同一事务里写入的多条留言时间戳相同，二级键保证顺序确定
    .orderBy(desc(taskComments.createdAt), desc(taskComments.id))
    .limit(limit);
}

export async function createTaskComment(userId: string, taskId: string, content: string) {
  const trimmed = content.trim();
  if (!trimmed) throw new AppError("留言内容不能为空");
  if (trimmed.length > 2000) throw new AppError("留言内容不能超过 2000 字符");

  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");

  const access = await getProjectForUser(userId, task.projectId);
  if (!access) throw new ForbiddenError();

  const [comment] = await db
    .insert(taskComments)
    .values({
      taskId,
      authorId: userId,
      content: trimmed,
    })
    .returning();

  return comment;
}

export async function deleteTaskComment(userId: string, commentId: string) {
  const [comment] = await db
    .select({
      id: taskComments.id,
      authorId: taskComments.authorId,
      taskId: taskComments.taskId,
      projectId: tasks.projectId,
    })
    .from(taskComments)
    .innerJoin(tasks, eq(taskComments.taskId, tasks.id))
    .where(eq(taskComments.id, commentId));

  if (!comment) throw new AppError("留言不存在");

  const access = await getProjectForUser(userId, comment.projectId);
  if (!access) throw new ForbiddenError();

  if (comment.authorId !== userId && access.role !== "admin") {
    throw new ForbiddenError("没有权限删除此留言");
  }

  await db.delete(taskComments).where(eq(taskComments.id, commentId));
}
