import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentFiles } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { ATTACHMENT_MAX_SIZE, getAttachmentForDownload, uploadAttachment } from "@/lib/attachment";
import { getDmAttachmentForDownload } from "@/lib/dm";
import type { MessageAttachment } from "./assistant-panel-shared";
import { ASSISTANT_ATTACHMENTS_MAX } from "./assistant-panel-shared";
import { extractFileText, type ExtractedFileText } from "./file-text";

/**
 * AI 助手对话里的文件（`agent_files`）——上传、下载、读正文、复制成任务附件。
 *
 * 权限只有一条：**ownerId === actorId**。与任务/消息附件不同，这里没有「项目成员」
 * 或「收发双方」可言：文件只活在用户自己的个人助手会话里。
 *
 * 复制进任务时改走任务附件那套口子（lib/attachment.ts 的 uploadAttachment），
 * 由它重校任务写权限与 10MB 上限 —— 与「消息文件添加为任务附件」同一路径。
 */

function clampFilename(raw: string): string {
  // 与任务附件同一口径：截到 200 字符，防超长名炸库列/响应头
  return raw.slice(0, 200) || "未命名文件";
}

export type AgentFileMeta = {
  id: string;
  filename: string;
  mimeType: string | null;
  size: number;
  createdAt: Date;
};

export async function saveAgentFile(
  actorId: string,
  input: { filename: string; mimeType?: string | null; size: number; data: Buffer },
): Promise<AgentFileMeta> {
  if (input.size > ATTACHMENT_MAX_SIZE) throw new AppError("文件不能超过 10MB");
  if (input.size === 0) throw new AppError("不能上传空文件");

  const [row] = await db
    .insert(agentFiles)
    .values({
      ownerId: actorId,
      filename: clampFilename(input.filename),
      mimeType: input.mimeType ?? null,
      size: input.size,
      data: input.data,
    })
    .returning({
      id: agentFiles.id,
      filename: agentFiles.filename,
      mimeType: agentFiles.mimeType,
      size: agentFiles.size,
      createdAt: agentFiles.createdAt,
    });
  return row;
}

/** 我的一个文件（不含 blob）；不存在或不是我的都当「不存在」，不泄露别人的 id 是否有效 */
export async function getAgentFileMeta(
  actorId: string,
  fileId: string,
): Promise<AgentFileMeta> {
  const [row] = await db
    .select({
      id: agentFiles.id,
      filename: agentFiles.filename,
      mimeType: agentFiles.mimeType,
      size: agentFiles.size,
      createdAt: agentFiles.createdAt,
    })
    .from(agentFiles)
    .where(and(eq(agentFiles.id, fileId), eq(agentFiles.ownerId, actorId)))
    .limit(1);
  if (!row) throw new AppError("文件不存在");
  return row;
}

export async function getAgentFileForDownload(actorId: string, fileId: string) {
  const [row] = await db
    .select({
      id: agentFiles.id,
      filename: agentFiles.filename,
      mimeType: agentFiles.mimeType,
      size: agentFiles.size,
      data: agentFiles.data,
    })
    .from(agentFiles)
    .where(and(eq(agentFiles.id, fileId), eq(agentFiles.ownerId, actorId)))
    .limit(1);
  if (!row) throw new AppError("文件不存在");
  return row;
}

export async function deleteAgentFile(actorId: string, fileId: string): Promise<void> {
  const deleted = await db
    .delete(agentFiles)
    .where(and(eq(agentFiles.id, fileId), eq(agentFiles.ownerId, actorId)))
    .returning({ id: agentFiles.id });
  if (deleted.length === 0) throw new AppError("文件不存在");
}

/**
 * 一轮提问带的文件：按传入顺序取元数据，任一缺失/不属于我就整体拒绝。
 * 上限 `ASSISTANT_ATTACHMENTS_MAX` —— 多图/多文档一口气塞进上下文既贵又没用。
 */
export async function loadAttachmentMetas(
  actorId: string,
  ids: readonly string[],
): Promise<MessageAttachment[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (unique.length > ASSISTANT_ATTACHMENTS_MAX)
    throw new AppError(`一句话最多带 ${ASSISTANT_ATTACHMENTS_MAX} 个文件`);

  const rows = await db
    .select({
      id: agentFiles.id,
      filename: agentFiles.filename,
      mimeType: agentFiles.mimeType,
      size: agentFiles.size,
    })
    .from(agentFiles)
    .where(and(inArray(agentFiles.id, unique), eq(agentFiles.ownerId, actorId)));

  if (rows.length !== unique.length) throw new AppError("有文件不存在或已被删除");
  const byId = new Map(rows.map((r) => [r.id, r]));
  return unique.map((id) => {
    const row = byId.get(id)!;
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
    };
  });
}

/** 读我的文件正文（模型用）。返回统一带上文件名/大小，读不了时给 note。 */
export async function readAgentFileText(
  actorId: string,
  fileId: string,
): Promise<{
  filename: string;
  mimeType: string | null;
  size: number;
} & ExtractedFileText> {
  const row = await getAgentFileForDownload(actorId, fileId);
  const extracted = await extractFileText({
    filename: row.filename,
    mimeType: row.mimeType,
    data: Buffer.from(row.data),
  });
  return { filename: row.filename, mimeType: row.mimeType, size: row.size, ...extracted };
}

/** 读任务附件正文（模型用）；读权限 = 项目成员，由 getAttachmentForDownload 收敛 */
export async function readTaskAttachmentText(
  actorId: string,
  attachmentId: string,
): Promise<{
  filename: string;
  mimeType: string | null;
  size: number;
} & ExtractedFileText> {
  const row = await getAttachmentForDownload(actorId, attachmentId);
  const extracted = await extractFileText({
    filename: row.filename,
    mimeType: row.mimeType,
    data: Buffer.from(row.data),
  });
  return { filename: row.filename, mimeType: row.mimeType, size: row.size, ...extracted };
}

/** 读私信/群聊附件正文（模型用）；读权限 = 收发双方 / 群成员，由 getDmAttachmentForDownload 收敛 */
export async function readMessageAttachmentText(
  actorId: string,
  attachmentId: string,
): Promise<{
  filename: string;
  mimeType: string | null;
  size: number;
} & ExtractedFileText> {
  const row = await getDmAttachmentForDownload(actorId, attachmentId);
  const extracted = await extractFileText({
    filename: row.filename,
    mimeType: row.mimeType,
    data: Buffer.from(row.data),
  });
  return { filename: row.filename, mimeType: row.mimeType, size: row.size, ...extracted };
}

/**
 * 把我的助手文件复制成任务附件（字节各存一份，与消息附件→任务附件同一取舍：
 * 任何一边删除都不影响另一边）。写权限与 10MB 上限由 uploadAttachment 重校。
 */
export async function copyAgentFileToTask(
  actorId: string,
  fileId: string,
  taskId: string,
): Promise<{ id: string; filename: string }> {
  const source = await getAgentFileForDownload(actorId, fileId);
  const row = await uploadAttachment(actorId, taskId, {
    filename: source.filename,
    mimeType: source.mimeType,
    size: source.size,
    data: Buffer.from(source.data),
  });
  return { id: row.id, filename: source.filename };
}
