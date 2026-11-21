import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, documentVersions, libraryVersions } from "@/db/schema";
import { AppError, DocumentLockError } from "@/lib/errors";
import { blobPath } from "@/lib/blob-store";
import { acquireLock, releaseLock } from "@/lib/documents/locks";
import { restoreDocumentVersion } from "@/lib/documents/service";
import { requireLibraryItemEdit } from "./access";
import { appendLibraryVersion, pruneLibraryItemVersions } from "./versions";
import type { LibraryOrigin } from "./types";

/**
 * 从预览窗恢复历史版本（没有编辑器会话，因此不能直接用 document_locks 语义）。
 *
 * - 条目还没有 documents 行：纯资源库恢复，追加一条 restore 版本。
 * - 已有 documents 行：单人模式临时抢锁，抢不到返回 423；抢到后复用
 *   restoreDocumentVersion，版本镜像由适配器 onVersionCommitted 完成。
 * - 协作模式：直接复用 restoreDocumentVersion（它本身跳过锁校验）。
 */
export async function restoreLibraryVersion(input: {
  itemId: string;
  userId: string;
  version: number;
}): Promise<{ version: number }> {
  const access = await requireLibraryItemEdit(input.userId, input.itemId);

  const [src] = await db
    .select()
    .from(libraryVersions)
    .where(
      and(
        eq(libraryVersions.itemId, input.itemId),
        eq(libraryVersions.version, input.version),
      ),
    );
  if (!src) throw new AppError("版本不存在");
  // 先确认 blob 还在（stat 不读文件内容，1GB 文件也不会进内存）
  try {
    await stat(blobPath(src.storageKey));
  } catch {
    throw new AppError("历史版本内容已丢失，无法恢复");
  }

  const [doc] = await db
    .select({ id: documents.id, collaborationEnabled: documents.collaborationEnabled })
    .from(documents)
    .where(
      and(
        eq(documents.sourceType, "library_item"),
        eq(documents.sourceId, input.itemId),
      ),
    );

  if (!doc) {
    const result = await db.transaction(async (tx) => {
      return appendLibraryVersion(
        tx,
        input.itemId,
        {
          storageKey: src.storageKey,
          size: src.size,
          mimeType: src.mimeType,
          filename: src.filename,
          editorState: src.editorState,
          note: "restore",
          origin: access.item.origin as LibraryOrigin,
          createdById: input.userId,
          operationType: "version_restored",
          operationNote: `恢复 v${input.version}`,
        },
        { id: input.userId, name: null },
      );
    });
    void pruneLibraryItemVersions(input.itemId).catch(() => {});
    return result;
  }

  // 目标版本必须出现在 document_versions 里，restoreDocumentVersion 才能找回内容
  await db
    .insert(documentVersions)
    .values({
      documentId: doc.id,
      version: src.version,
      filename: src.filename,
      mimeType: src.mimeType,
      size: src.size,
      storageKey: src.storageKey,
      editorState: src.editorState,
      note: src.note,
      createdById: src.createdById,
      createdAt: src.createdAt,
    })
    .onConflictDoNothing();

  const sessionId = `restore-${randomUUID()}`;
  if (!doc.collaborationEnabled) {
    const lock = await acquireLock(doc.id, input.userId, sessionId);
    if (!lock) {
      throw new DocumentLockError(
        "有人正在编辑该文件，暂时无法恢复历史版本",
        "held",
      );
    }
    try {
      return await restoreDocumentVersion({
        documentId: doc.id,
        userId: input.userId,
        sessionId,
        version: input.version,
      });
    } finally {
      await releaseLock(doc.id, input.userId, sessionId).catch(() => {});
    }
  }

  return restoreDocumentVersion({
    documentId: doc.id,
    userId: input.userId,
    sessionId,
    version: input.version,
  });
}
