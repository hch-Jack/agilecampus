import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects, taskAttachments, tasks } from "@/db/schema";
import { recordTaskActivity } from "@/lib/activity";
import { readStoredContent } from "@/lib/blob-store";
import { AppError } from "@/lib/errors";
import { getProjectForUser } from "@/lib/project";
import { detectEditableFormat } from "../format";
import type {
  DbExec,
  DocumentSourceAdapter,
  LoadedDocumentSource,
  SourceContent,
  StoredContentRef,
} from "../types";

export const TASK_ATTACHMENT_SOURCE = "task_attachment";

type AttachmentRow = {
  id: string;
  taskId: string;
  filename: string;
  mimeType: string | null;
  size: number;
  storageKey: string | null;
  uploaderId: string;
  projectId: string;
  teamId: string;
};

async function getAttachmentRow(sourceId: string, exec: DbExec): Promise<AttachmentRow | null> {
  const [row] = await exec
    .select({
      id: taskAttachments.id,
      taskId: taskAttachments.taskId,
      filename: taskAttachments.filename,
      mimeType: taskAttachments.mimeType,
      size: taskAttachments.size,
      storageKey: taskAttachments.storageKey,
      uploaderId: taskAttachments.uploaderId,
      projectId: projects.id,
      teamId: projects.teamId,
    })
    .from(taskAttachments)
    .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .where(eq(taskAttachments.id, sourceId));
  return row ?? null;
}

/**
 * 任务附件来源。
 *
 * 读权限 = 项目成员（团队成员）；管理权 = 上传者或团队 admin。
 * 编辑权由 documents 服务在管理权/额外授权之上推导，这里只给来源事实。
 */
export const taskAttachmentAdapter: DocumentSourceAdapter = {
  sourceType: TASK_ATTACHMENT_SOURCE,

  async load(userId, sourceId, exec = db) {
    const row = await getAttachmentRow(sourceId, exec);
    if (!row) return null;
    const access = await getProjectForUser(userId, row.projectId);
    if (!access) return null;
    const info = detectEditableFormat(row.filename, row.mimeType, row.size);
    if (!info.editable) return null;

    return {
      sourceType: TASK_ATTACHMENT_SOURCE,
      sourceId: row.id,
      format: info.format,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      ownerUserId: row.uploaderId,
      canManage: access.role === "admin" || row.uploaderId === userId,
      role: access.role,
      taskId: row.taskId,
      teamId: row.teamId,
      projectId: row.projectId,
    } satisfies LoadedDocumentSource;
  },

  async read(source, maxBytes) {
    const [row] = await db
      .select({
        data: taskAttachments.data,
        storageKey: taskAttachments.storageKey,
        filename: taskAttachments.filename,
        mimeType: taskAttachments.mimeType,
        size: taskAttachments.size,
      })
      .from(taskAttachments)
      .where(eq(taskAttachments.id, source.sourceId));
    if (!row) throw new AppError("附件不存在");
    const data = await readStoredContent(row, maxBytes);
    return {
      data,
      filename: row.filename,
      mimeType: row.mimeType,
      size: data.length,
      storageKey: row.storageKey,
    } satisfies SourceContent;
  },

  async replace(exec, source, next: StoredContentRef) {
    const rows = await exec
      .update(taskAttachments)
      .set({
        storageKey: next.storageKey,
        data: Buffer.alloc(0),
        size: next.size,
        mimeType: next.mimeType,
      })
      .where(eq(taskAttachments.id, source.sourceId))
      .returning({ id: taskAttachments.id });
    if (rows.length === 0) throw new AppError("附件已被删除，无法保存");
  },

  async createCopy(exec, actorId, source, next: StoredContentRef) {
    if (!source.taskId) throw new AppError("附件不属于任何任务");
    const [row] = await exec
      .insert(taskAttachments)
      .values({
        taskId: source.taskId,
        uploaderId: actorId,
        filename: next.filename,
        mimeType: next.mimeType,
        size: next.size,
        data: Buffer.alloc(0),
        storageKey: next.storageKey,
      })
      .returning({ id: taskAttachments.id });
    return {
      ...source,
      sourceId: row.id,
      filename: next.filename,
      mimeType: next.mimeType,
      size: next.size,
      ownerUserId: actorId,
      canManage: true,
    } satisfies LoadedDocumentSource;
  },

  async recordActivity(exec, actorId, source, event) {
    if (!source.taskId) return;
    await recordTaskActivity(exec, [
      { taskId: source.taskId, actorId, type: event.type, newValue: event.newValue },
    ]);
  },
};
