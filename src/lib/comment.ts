import { eq, asc } from "drizzle-orm";
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
