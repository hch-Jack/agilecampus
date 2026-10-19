import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { taskAttachments, tasks, users } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser } from "./project";
import { requireTaskWrite } from "./task";
import { recordTaskActivity } from "./activity";
import { getDmAttachmentForDownload } from "./dm";

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

/**
 * 附件元数据（不含 blob）：供助手拟草案时校验归属、在卡片上展示文件名。
 * 读权限是项目成员；写权限由调用方（删除/复制）另行收口。
 */
export async function getAttachmentMeta(actorId: string, attachmentId: string) {
  const [row] = await db
    .select({
      id: taskAttachments.id,
      taskId: taskAttachments.taskId,
      taskTitle: tasks.title,
      filename: taskAttachments.filename,
      mimeType: taskAttachments.mimeType,
      size: taskAttachments.size,
      createdAt: taskAttachments.createdAt,
      uploaderName: users.name,
      projectId: tasks.projectId,
    })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .leftJoin(users, eq(taskAttachments.uploaderId, users.id))
    .where(eq(taskAttachments.id, attachmentId));
  if (!row) throw new AppError("附件不存在");
  await requireProjectAccess(actorId, row.projectId);
  return row;
}

// `projectId` 可选：助手落库口带着「当前项目」进来，跨项目附件在这里就拒掉，
// 不靠调用方各自记得比对。
export async function deleteAttachment(
  actorId: string,
  attachmentId: string,
  opts?: { projectId?: string },
) {
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
  if (opts?.projectId && row.projectId !== opts.projectId)
    throw new AppError("附件不属于该项目");
  await requireTaskWrite(actorId, row.projectId);

  await db.delete(taskAttachments).where(eq(taskAttachments.id, attachmentId));
  await recordTaskActivity(db, [
    { taskId: row.taskId, actorId, type: "attachment_deleted", newValue: row.filename },
  ]);
}

/**
 * 把消息里的文件复制成任务附件。
 *
 * `dm_attachments` 与 `task_attachments` 是两张互不关联的表（都能存 blob），
 * 故这里**复制字节**新建一行，而不是引用共享同一行：消息删除/附件清理不会连带
 * 弄丢任务附件，任务附件删除也不影响聊天记录。代价是同一文件存两份 —— 单文件
 * 上限 10MB，可接受。
 */
export async function copyMessageAttachmentToTask(
  actorId: string,
  messageAttachmentId: string,
  taskId: string,
) {
  // 先验消息附件权限（私信收发双方 / 群成员），再让 uploadAttachment 验任务写权限
  const source = await getDmAttachmentForDownload(actorId, messageAttachmentId);
  const row = await uploadAttachment(actorId, taskId, {
    filename: source.filename,
    mimeType: source.mimeType,
    size: source.size,
    data: Buffer.from(source.data),
  });
  return { id: row.id, filename: source.filename };
}
