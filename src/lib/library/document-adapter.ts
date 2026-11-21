import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  documents,
  documentVersions,
  libraryItems,
  libraryVersions,
} from "@/db/schema";
import { AppError } from "@/lib/errors";
import { readBlob } from "@/lib/blob-store";
import { detectEditableFormat } from "@/lib/documents/format";
import type {
  DbExec,
  DocumentSourceAdapter,
  LoadedDocumentSource,
} from "@/lib/documents/types";
import { getLibraryItemAccess } from "./access";
import { recordLibraryOperation } from "./operations";
import { appendLibraryVersion, detachLiveLinksForEdit } from "./versions";
import type { LibraryOrigin, LibraryVersionNote } from "./types";

export const LIBRARY_ITEM_SOURCE = "library_item";

function noteOf(note: string): LibraryVersionNote {
  switch (note) {
    case "initial":
    case "autosave":
    case "manual":
    case "restore":
    case "save_as":
    case "sync":
    case "import":
      return note;
    default:
      return "manual";
  }
}

async function getItemRow(sourceId: string, exec: DbExec = db) {
  const [item] = await exec
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.id, sourceId));
  return item ?? null;
}

/**
 * 资源库条目作为文档来源。
 *
 * - 权限：个人库 owner；团队库 admin/student。`grantsEnabled=false` 让教师保持只读。
 * - 版本：documents 与 library_versions 同号镜像；首次打开时 seed 历史。
 * - replace 留空：内容/版本统一由同事务的 onVersionCommitted 写入。
 */
export const libraryItemAdapter: DocumentSourceAdapter = {
  sourceType: LIBRARY_ITEM_SOURCE,

  async load(userId, sourceId) {
    const access = await getLibraryItemAccess(userId, sourceId);
    if (!access) return null;
    const item = access.item;
    const info = detectEditableFormat(item.filename, item.mimeType, item.size);
    if (!info.editable) return null;

    return {
      sourceType: LIBRARY_ITEM_SOURCE,
      sourceId: item.id,
      format: info.format,
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size,
      ownerUserId: item.createdById ?? userId,
      canManage: access.canEdit,
      role: access.role,
      taskId: null,
      teamId: access.library.teamId,
      projectId: null,
      currentVersion: item.currentVersion,
      grantsEnabled: false,
    } satisfies LoadedDocumentSource;
  },

  async read(source, maxBytes) {
    const item = await getItemRow(source.sourceId);
    if (!item) throw new AppError("资源库文件已被删除");
    const [version] = await db
      .select()
      .from(libraryVersions)
      .where(
        and(
          eq(libraryVersions.itemId, item.id),
          eq(libraryVersions.version, item.currentVersion),
        ),
      );
    if (!version) throw new AppError("资源库版本不存在");
    const data = await readBlob(version.storageKey, maxBytes);
    return {
      data,
      filename: version.filename,
      mimeType: version.mimeType,
      size: data.length,
      storageKey: version.storageKey,
    };
  },

  async replace() {
    // 条目内容与版本由 onVersionCommitted 在同一事务里写入
  },

  async createCopy() {
    throw new AppError("资源库文件请使用「另存为」选择目标资源库和文件夹");
  },

  async recordActivity(exec, actorId, source, event) {
    const item = await getItemRow(source.sourceId, exec);
    if (!item) return;
    await recordLibraryOperation(exec, {
      libraryId: item.libraryId,
      itemId: item.id,
      actorId,
      type: event.type,
      newValue: event.newValue,
    });
  },

  async onVersionCommitted(exec, actorId, source, version) {
    // 在线编辑后停止跟随来源，避免下一次同步打乱当前内容
    await detachLiveLinksForEdit(exec, source.sourceId, actorId);
    const item = await getItemRow(source.sourceId, exec);
    if (!item) throw new AppError("资源库文件已被删除");

    await appendLibraryVersion(
      exec,
      source.sourceId,
      {
        storageKey: version.storageKey,
        size: version.size,
        mimeType: version.mimeType,
        filename: version.filename,
        editorState: version.editorState,
        note: noteOf(version.note),
        origin: item.origin as LibraryOrigin,
        createdById: version.createdById,
        version: version.version,
        operationType: "document_saved",
        operationNote: `v${version.version}`,
        createdAt: version.createdAt,
      },
      { id: actorId, name: null },
    );
  },

  async seedDocumentVersions(exec, source, documentId) {
    const item = await getItemRow(source.sourceId, exec);
    if (!item) return;
    const versions = await exec
      .select()
      .from(libraryVersions)
      .where(eq(libraryVersions.itemId, item.id))
      .orderBy(asc(libraryVersions.version));
    for (const v of versions) {
      await exec
        .insert(documentVersions)
        .values({
          documentId,
          version: v.version,
          filename: v.filename,
          mimeType: v.mimeType,
          size: v.size,
          storageKey: v.storageKey,
          editorState: v.editorState,
          note: v.note,
          createdById: v.createdById,
          createdAt: v.createdAt,
        })
        .onConflictDoNothing();
    }
    await exec
      .update(documents)
      .set({
        currentVersion: sql`greatest(${documents.currentVersion}, ${item.currentVersion})`,
        filename: item.filename,
        mimeType: item.mimeType,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, documentId));
  },
};
