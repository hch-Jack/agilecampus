import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agentFiles } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { getAttachmentForDownload, uploadAttachment } from "@/lib/attachment";
import { getDmAttachmentForDownload } from "@/lib/dm";
import {
  deleteBlob,
  persistBlob,
  readStoredContent,
  type FileContentInput,
} from "@/lib/blob-store";
import { MAX_FILE_SIZE } from "@/lib/file-limits";
import type { MessageAttachment } from "./assistant-panel-shared";
import { ASSISTANT_ATTACHMENTS_MAX } from "./assistant-panel-shared";
import { extractFileText, type ExtractedFileText } from "./file-text";

/**
 * AI 助手对话里的文件（`agent_files`）——上传、生成、下载、读正文、复制成任务附件。
 *
 * 权限只有一条：**ownerId === actorId**。与任务/消息附件不同，这里没有「项目成员」
 * 或「收发双方」可言：文件只活在用户自己的个人助手会话里。
 *
 * 单文件上限 1GB；大文件由上传路由流式写盘，库里只留 `storageKey`。
 *
 * 复制进任务时改走任务附件那套口子（lib/attachment.ts 的 uploadAttachment），
 * 由它重校任务写权限与上限 —— 与「消息文件添加为任务附件」同一路径。
 */

// 正文抽取上限：docx/xlsx 解析需要整份文件，1GB 的表格拉进内存没有意义；
// 超限就明确告诉模型「改用预览/下载」，别把服务打爆。
const READ_TEXT_MAX_BYTES = 32 * 1024 * 1024;

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
  input: {
    filename: string;
    mimeType?: string | null;
    size?: number;
  } & FileContentInput,
): Promise<AgentFileMeta> {
  const blob = await persistBlob(input, MAX_FILE_SIZE);
  const filename = clampFilename(input.filename);

  try {
    const [row] = await db
      .insert(agentFiles)
      .values({
        ownerId: actorId,
        filename,
        mimeType: input.mimeType ?? null,
        size: blob.size,
        data: blob.data,
        storageKey: blob.storageKey,
      })
      .returning({
        id: agentFiles.id,
        filename: agentFiles.filename,
        mimeType: agentFiles.mimeType,
        size: agentFiles.size,
        createdAt: agentFiles.createdAt,
      });
    return row;
  } catch (e) {
    await deleteBlob(blob.storageKey);
    throw e;
  }
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
      storageKey: agentFiles.storageKey,
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
    .returning({ id: agentFiles.id, storageKey: agentFiles.storageKey });
  if (deleted.length === 0) throw new AppError("文件不存在");
  await deleteBlob(deleted[0].storageKey);
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

/** 从任意附件行抽正文：磁盘 blob 按上限读入，超大文件直接给说明 */
async function extractFromStoredRow(row: {
  filename: string;
  mimeType: string | null;
  size: number;
  data?: Buffer | Uint8Array | null;
  storageKey?: string | null;
}): Promise<ExtractedFileText> {
  if (row.size > READ_TEXT_MAX_BYTES) {
    return {
      note: `文件较大（${Math.ceil(row.size / 1024 / 1024)}MB），超过 32MB 的正文解析上限。请改用预览或下载后查看。`,
    };
  }
  const data = await readStoredContent(row, READ_TEXT_MAX_BYTES);
  return extractFileText({ filename: row.filename, mimeType: row.mimeType, data });
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
  const extracted = await extractFromStoredRow(row);
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
  const extracted = await extractFromStoredRow(row);
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
  const extracted = await extractFromStoredRow(row);
  return { filename: row.filename, mimeType: row.mimeType, size: row.size, ...extracted };
}

/**
 * 把我的助手文件复制成任务附件（各存一份，与消息附件→任务附件同一取舍：
 * 任何一边删除都不影响另一边）。写权限与上限由 uploadAttachment 重校；
 * 磁盘上的大文件直接复制 blob，不整份读进内存。
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
    ...(source.storageKey
      ? { storageKey: source.storageKey }
      : { data: await readStoredContent(source) }),
  });
  return { id: row.id, filename: source.filename };
}
