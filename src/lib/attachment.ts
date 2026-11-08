import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, taskAttachments, tasks, teamMembers, users } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser } from "./project";
import { requireTaskWrite } from "./task";
import { recordTaskActivity } from "./activity";
import { getDmAttachmentForDownload } from "./dm";
import {
  deleteBlob,
  persistBlob,
  readStoredContent,
  type FileContentInput,
} from "./blob-store";
import { MAX_FILE_SIZE } from "./file-limits";

// 单文件大小上限：1GB。真正的上传走 route handler 流式写盘（/api/attachments/upload），
// server action 只保留给小文件的兼容路径（其 body 上限仍受 next.config 约束）。
export const ATTACHMENT_MAX_SIZE = MAX_FILE_SIZE;

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

/**
 * 工作台「最近附件」：我所在团队、未归档项目里最新的任务附件（不含文件内容）。
 * 跨项目聚合，只取最近几条。
 */
export async function listMyRecentAttachments(actorId: string, limit = 8) {
  return db
    .select({
      id: taskAttachments.id,
      filename: taskAttachments.filename,
      mimeType: taskAttachments.mimeType,
      size: taskAttachments.size,
      createdAt: taskAttachments.createdAt,
      uploaderName: users.name,
      taskId: tasks.id,
      taskTitle: tasks.title,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, actorId)),
    )
    .leftJoin(users, eq(taskAttachments.uploaderId, users.id))
    .where(eq(projects.status, "active"))
    .orderBy(desc(taskAttachments.createdAt))
    .limit(limit);
}

/** 上传前的权限预检：先校写权限，再收 1GB 的字节流，别让无权的人白传一遍 */
export async function assertCanUploadAttachment(actorId: string, taskId: string) {
  await requireTaskWrite(actorId, await getTaskProjectId(taskId));
}

/**
 * 落一条任务附件。内容二选一：
 * - `storageKey`：磁盘上的源文件，复制一份新 blob（大文件走这条）；
 * - `data`：内存字节，直接进库（历史路径、测试、小文件复制）。
 */
export async function uploadAttachment(
  actorId: string,
  taskId: string,
  input: {
    filename: string;
    mimeType?: string | null;
    size?: number;
  } & FileContentInput,
) {
  const projectId = await getTaskProjectId(taskId);
  await requireTaskWrite(actorId, projectId);

  const blob = await persistBlob(input, ATTACHMENT_MAX_SIZE);
  // 文件名截断到 200 字符，防超长名炸库列/响应头
  const filename = input.filename.slice(0, 200) || "未命名文件";

  let row;
  try {
    [row] = await db
      .insert(taskAttachments)
      .values({
        taskId,
        uploaderId: actorId,
        filename,
        mimeType: input.mimeType ?? null,
        size: blob.size,
        data: blob.data,
        storageKey: blob.storageKey,
      })
      .returning({ id: taskAttachments.id });
  } catch (e) {
    // 行没落成，磁盘副本别留着
    await deleteBlob(blob.storageKey);
    throw e;
  }

  await recordTaskActivity(db, [
    { taskId, actorId, type: "attachment_added", newValue: filename },
  ]);
  return row;
}

// 下载取回：项目成员即可读；内容随行返回（磁盘路径只带 storageKey，不读字节）
export async function getAttachmentForDownload(actorId: string, attachmentId: string) {
  const [row] = await db
    .select({
      id: taskAttachments.id,
      filename: taskAttachments.filename,
      mimeType: taskAttachments.mimeType,
      size: taskAttachments.size,
      data: taskAttachments.data,
      storageKey: taskAttachments.storageKey,
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
      storageKey: taskAttachments.storageKey,
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
  await deleteBlob(row.storageKey);
  await recordTaskActivity(db, [
    { taskId: row.taskId, actorId, type: "attachment_deleted", newValue: row.filename },
  ]);
}

/**
 * 把消息里的文件复制成任务附件。
 *
 * `dm_attachments` 与 `task_attachments` 是两张互不关联的表，故这里**各存一份**
 * 新建一行，而不是引用共享同一行：消息删除/附件清理不会连带弄丢任务附件，任务
 * 附件删除也不影响聊天记录。磁盘上的源文件按 blob 复制，不整份读进内存。
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
    ...(source.storageKey
      ? { storageKey: source.storageKey }
      : { data: await readStoredContent(source) }),
  });
  return { id: row.id, filename: source.filename };
}
