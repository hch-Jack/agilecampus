import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { taskAttachments, tasks, users } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser } from "./project";
import { requireTaskWrite } from "./task";
import { recordTaskActivity } from "./activity";

// 单文件大小上限：10MB。上传走 server action，体积限制须与 next.config 的
// experimental.serverActions.bodySizeLimit（12mb，含 multipart 开销余量）配套。
export const ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024;

async function requireProjectAccess(actorId: string, projectId: string) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  return access;
}

async function getTaskProjectId(taskId: string) {
  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");
  return task.projectId;
}

// 列任务附件：所有项目成员可读。不选 data 列——列表不需要二进制内容，二进制仅下载路径取。
export async function listAttachments(actorId: string, taskId: string) {
  await requireProjectAccess(actorId, await getTaskProjectId(taskId));
  return db
    .select({
      id: taskAttachments.id,
      filename: taskAttachments.filename,
      mimeType: taskAttachments.mimeType,
      size: taskAttachments.size,
      createdAt: taskAttachments.createdAt,
      uploaderName: users.name,
    })
    .from(taskAttachments)
    .leftJoin(users, eq(taskAttachments.uploaderId, users.id))
    .where(eq(taskAttachments.taskId, taskId))
    .orderBy(desc(taskAttachments.createdAt));
}

export async function uploadAttachment(
  actorId: string,
  taskId: string,
  input: { filename: string; mimeType?: string | null; size: number; data: Buffer },
) {
  const projectId = await getTaskProjectId(taskId);
  await requireTaskWrite(actorId, projectId);
  if (input.size > ATTACHMENT_MAX_SIZE) throw new AppError("附件不能超过 10MB");
  if (input.size === 0) throw new AppError("不能上传空文件");
  // 文件名截断到 200 字符，防超长名炸库列/响应头
  const filename = input.filename.slice(0, 200) || "未命名文件";

  const [row] = await db
    .insert(taskAttachments)
    .values({
      taskId,
      uploaderId: actorId,
      filename,
      mimeType: input.mimeType ?? null,
      size: input.size,
      data: input.data,
    })
    .returning({ id: taskAttachments.id });

  await recordTaskActivity(db, [
    { taskId, actorId, type: "attachment_added", newValue: filename },
  ]);
  return row;
}

// 下载取回：项目成员即可读；内容随行返回，仅此路径取 data 列
export async function getAttachmentForDownload(actorId: string, attachmentId: string) {
  const [row] = await db
    .select({
      id: taskAttachments.id,
      filename: taskAttachments.filename,
      mimeType: taskAttachments.mimeType,
      size: taskAttachments.size,
      data: taskAttachments.data,
      projectId: tasks.projectId,
    })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .where(eq(taskAttachments.id, attachmentId));
  if (!row) throw new AppError("附件不存在");
  await requireProjectAccess(actorId, row.projectId);
  return row;
}

export async function deleteAttachment(actorId: string, attachmentId: string) {
  const [row] = await db
    .select({
      id: taskAttachments.id,
      taskId: taskAttachments.taskId,
      filename: taskAttachments.filename,
      projectId: tasks.projectId,
    })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .where(eq(taskAttachments.id, attachmentId));
  if (!row) throw new AppError("附件不存在");
  await requireTaskWrite(actorId, row.projectId);

  await db.delete(taskAttachments).where(eq(taskAttachments.id, attachmentId));
  await recordTaskActivity(db, [
    { taskId: row.taskId, actorId, type: "attachment_deleted", newValue: row.filename },
  ]);
}
