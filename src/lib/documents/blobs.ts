import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { documentVersions, documents } from "@/db/schema";
import { deleteBlob } from "@/lib/blob-store";

/** 版本保留：最新 50 个 + 第 1 版（原始版）。当前版本永不裁剪。 */
const VERSION_KEEP_LATEST = 50;

/**
 * blob 是否仍被任何表引用。删除版本/附件前必须过这一道：
 * 当前版本与 task_attachments 允许共用同一个 key。
 */
export async function blobIsReferenced(storageKey: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select (
      exists(select 1 from task_attachments where storage_key = ${storageKey})
      or exists(select 1 from document_versions where storage_key = ${storageKey})
      or exists(select 1 from dm_attachments where storage_key = ${storageKey})
      or exists(select 1 from agent_files where storage_key = ${storageKey})
    ) as used
  `)) as unknown as { used: boolean }[];
  return Boolean(rows[0]?.used);
}

export async function deleteBlobIfUnreferenced(storageKey: string | null | undefined): Promise<void> {
  if (!storageKey) return;
  if (await blobIsReferenced(storageKey)) return;
  await deleteBlob(storageKey);
}

/**
 * 裁剪文档版本：保留最新 50 + 第 1 版；删行后按引用检查删 blob。
 * 在保存提交后异步调用，失败只影响磁盘占用，不影响保存结果。
 */
export async function pruneDocumentVersions(documentId: string): Promise<void> {
  const rows = await db
    .select({
      id: documentVersions.id,
      version: documentVersions.version,
      storageKey: documentVersions.storageKey,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.version));

  if (rows.length <= VERSION_KEEP_LATEST + 1) return;

  const keep = new Set<number>();
  for (const row of rows.slice(0, VERSION_KEEP_LATEST)) keep.add(row.version);
  keep.add(1);

  const doomed = rows.filter((row) => !keep.has(row.version));
  if (doomed.length === 0) return;

  await db.delete(documentVersions).where(
    and(
      eq(documentVersions.documentId, documentId),
      inArray(
        documentVersions.id,
        doomed.map((row) => row.id),
      ),
    ),
  );
  for (const row of doomed) await deleteBlobIfUnreferenced(row.storageKey);
}

/** 删除附件前调用：拿到该附件对应文档的所有版本 blob key */
export async function getDocumentBlobKeysForAttachment(attachmentId: string): Promise<string[]> {
  const rows = await db
    .select({ storageKey: documentVersions.storageKey })
    .from(documentVersions)
    .innerJoin(documents, eq(documentVersions.documentId, documents.id))
    .where(
      and(eq(documents.sourceType, "task_attachment"), eq(documents.sourceId, attachmentId)),
    );
  return rows.map((row) => row.storageKey);
}

/**
 * 删除任务前调用：收集整棵子任务树的附件 blob 与文档版本 blob。
 *
 * 任务级联删除会把 task_attachments / documents / document_versions 行一并带走，
 * 但磁盘文件不会自己消失。先收集 key，删完任务后再逐个做引用检查清理。
 */
export async function collectTaskTreeBlobKeys(taskId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    with recursive tree as (
      select id from tasks where id = ${taskId}
      union all
      select t.id from tasks t join tree on t.parent_task_id = tree.id
    )
    select ta.storage_key as key from tree
      join task_attachments ta on ta.task_id = tree.id
    union
    select dv.storage_key as key from tree
      join documents d on d.task_id = tree.id
      join document_versions dv on dv.document_id = d.id
  `)) as unknown as { key: string | null }[];
  return rows.map((row) => row.key).filter((key): key is string => Boolean(key));
}

/** 删除来源（任务附件等）后清理其文档行与版本 blob */
export async function deleteDocumentsForSource(
  sourceType: string,
  sourceId: string,
): Promise<void> {
  const docs = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.sourceType, sourceType), eq(documents.sourceId, sourceId)));
  if (docs.length === 0) return;

  const ids = docs.map((d) => d.id);
  const versionRows = await db
    .select({ storageKey: documentVersions.storageKey })
    .from(documentVersions)
    .where(inArray(documentVersions.documentId, ids));
  await db.delete(documents).where(inArray(documents.id, ids));
  for (const row of versionRows) await deleteBlobIfUnreferenced(row.storageKey);
}
