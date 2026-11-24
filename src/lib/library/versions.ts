import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  documents,
  documentVersions,
  libraryFolders,
  libraryItems,
  librarySourceLinks,
  libraryVersions,
  users,
} from "@/db/schema";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { DbExec } from "@/lib/documents/types";
import { deleteBlobIfUnreferenced } from "@/lib/documents/blobs";
import { deleteAttachment } from "@/lib/attachment";
import { deleteAgentFile } from "@/lib/agent/files";
import {
  assertFolderInLibrary,
  requireLibraryItemAccess,
  requireLibraryItemEdit,
} from "./access";
import { listLibraryOperations, recordLibraryOperation } from "./operations";
import type {
  AppendVersionInput,
  LibraryFolderRow,
  LibraryItemAccess,
  LibraryItemRow,
  LibraryOperationView,
  LibraryOrigin,
  LibraryRow,
  LibraryVersionNote,
  LibraryVersionView,
} from "./types";

export type LibraryItemDetail = {
  item: LibraryItemRow;
  library: LibraryRow;
  folder: LibraryFolderRow | null;
  access: LibraryItemAccess;
  versions: LibraryVersionView[];
  operations: LibraryOperationView[];
  links: {
    id: string;
    sourceType: string;
    sourceId: string;
    mode: string;
    origin: string;
    lastSourceVersion: number | null;
  }[];
  contentUrl: string;
  currentContentUrl: string;
};

const VERSION_KEEP_LATEST = 50;
const VERSION_KEEP_TOTAL = VERSION_KEEP_LATEST + 1; // 最新 50 + v1

async function getItemForUpdate(exec: DbExec, itemId: string): Promise<LibraryItemRow> {
  const [item] = await exec
    .select()
    .from(libraryItems)
    .where(eq(libraryItems.id, itemId))
    .for("update");
  if (!item) throw new AppError("资源库文件已被删除");
  return item;
}

/**
 * 追加一个版本。所有写版本的入口都走这里：
 * 条目行锁串行取号；若该条目已有 documents 行，同步同号写入 document_versions，
 * 保证编辑器侧栏和资源库预览看到的是同一套版本。
 */
export async function appendLibraryVersion(
  exec: DbExec,
  itemId: string,
  input: AppendVersionInput,
  actor?: { id: string; name: string | null },
): Promise<{ version: number }> {
  const item = await getItemForUpdate(exec, itemId);
  if (input.sourceKey) {
    const [existing] = await exec
      .select({ version: libraryVersions.version })
      .from(libraryVersions)
      .where(
        and(
          eq(libraryVersions.itemId, item.id),
          eq(libraryVersions.sourceKey, input.sourceKey),
        ),
      );
    if (existing) return { version: existing.version };
  }
  const version = input.version ?? item.currentVersion + 1;
  if (version < 1) throw new AppError("版本号不合法");
  const filename = input.filename ?? item.filename;

  await exec.insert(libraryVersions).values({
    libraryId: item.libraryId,
    itemId: item.id,
    version,
    filename,
    mimeType: input.mimeType,
    size: input.size,
    storageKey: input.storageKey,
    sourceKey: input.sourceKey ?? null,
    editorState: input.editorState ?? null,
    note: input.note,
    origin: input.origin,
    createdById: input.createdById,
    createdAt: input.createdAt ?? undefined,
  });

  await exec
    .update(libraryItems)
    .set({
      filename,
      mimeType: input.mimeType,
      size: input.size,
      currentVersion: sql`greatest(${libraryItems.currentVersion}, ${version})`,
      currentStorageKey: input.storageKey,
      origin: input.origin,
      updatedAt: sql`now()`,
    })
    .where(eq(libraryItems.id, item.id));

  // 文档镜像：编辑器保存/恢复时 service 已插过 document_versions，这里 onConflict 兜底；
  // 资源库同步/恢复触发的版本则需要补插。
  const [doc] = await exec
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.sourceType, "library_item"), eq(documents.sourceId, item.id)));
  if (doc) {
    await exec
      .insert(documentVersions)
      .values({
        documentId: doc.id,
        version,
        filename,
        mimeType: input.mimeType,
        size: input.size,
        storageKey: input.storageKey,
        editorState: input.editorState ?? null,
        note: input.note,
        createdById: input.createdById,
      })
      .onConflictDoNothing();
    await exec
      .update(documents)
      .set({
        currentVersion: sql`greatest(${documents.currentVersion}, ${version})`,
        filename,
        mimeType: input.mimeType,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, doc.id));
  }

  if (input.operationType) {
    await recordLibraryOperation(exec, {
      libraryId: item.libraryId,
      itemId: item.id,
      actorId: input.createdById,
      actorName: actor?.name ?? undefined,
      type: input.operationType,
      newValue: filename,
      note: input.operationNote ?? `v${version}`,
    });
  }

  return { version };
}

/**
 * 按「库 + 文件夹 + 文件名」写入版本：存在则追加，不存在则建条目 + v1。
 * 同名合并的核心入口。
 */
export async function putVersionByName(
  exec: DbExec,
  opts: {
    library: LibraryRow;
    /** null = 资源库根目录 */
    folderId: string | null;
    filename: string;
    mimeType: string | null;
    storageKey: string;
    size: number;
    editorState?: unknown;
    note: LibraryVersionNote;
    origin: LibraryOrigin;
    createdById: string | null;
    operationType?: string;
    operationNote?: string;
    createdAt?: Date;
    sourceKey?: string;
  },
): Promise<{ itemId: string; version: number; created: boolean }> {
  const existing = await findItemByName(exec, opts.library.id, opts.folderId, opts.filename);
  if (existing) {
    const result = await appendLibraryVersion(exec, existing.id, {
      storageKey: opts.storageKey,
      size: opts.size,
      mimeType: opts.mimeType,
      filename: opts.filename,
      editorState: opts.editorState,
      note: opts.note,
      origin: opts.origin,
      createdById: opts.createdById,
      operationType: opts.operationType,
      operationNote: opts.operationNote,
      createdAt: opts.createdAt,
      sourceKey: opts.sourceKey,
    });
    return { itemId: existing.id, version: result.version, created: false };
  }

  const [inserted] = await exec
    .insert(libraryItems)
    .values({
      libraryId: opts.library.id,
      folderId: opts.folderId,
      filename: opts.filename,
      mimeType: opts.mimeType,
      size: opts.size,
      currentVersion: 1,
      currentStorageKey: opts.storageKey,
      origin: opts.origin,
      createdById: opts.createdById,
    })
    .onConflictDoNothing()
    .returning({ id: libraryItems.id });

  if (!inserted) {
    // 并发下别人先建了同名条目：回查后追加
    const raced = await findItemByName(exec, opts.library.id, opts.folderId, opts.filename);
    if (!raced) throw new AppError("创建资源库文件失败，请重试");
    const result = await appendLibraryVersion(exec, raced.id, {
      storageKey: opts.storageKey,
      size: opts.size,
      mimeType: opts.mimeType,
      filename: opts.filename,
      editorState: opts.editorState,
      note: opts.note,
      origin: opts.origin,
      createdById: opts.createdById,
      operationType: opts.operationType,
      operationNote: opts.operationNote,
      createdAt: opts.createdAt,
      sourceKey: opts.sourceKey,
    });
    return { itemId: raced.id, version: result.version, created: false };
  }

  await exec.insert(libraryVersions).values({
    libraryId: opts.library.id,
    itemId: inserted.id,
    version: 1,
    filename: opts.filename,
    mimeType: opts.mimeType,
    size: opts.size,
    storageKey: opts.storageKey,
    sourceKey: opts.sourceKey ?? null,
    editorState: opts.editorState ?? null,
    note: opts.note,
    origin: opts.origin,
    createdById: opts.createdById,
    createdAt: opts.createdAt ?? undefined,
  });

  await recordLibraryOperation(exec, {
    libraryId: opts.library.id,
    itemId: inserted.id,
    folderId: opts.folderId,
    actorId: opts.createdById,
    type: opts.operationType ?? "item_created",
    newValue: opts.filename,
    note: opts.operationNote ?? "v1",
  });

  return { itemId: inserted.id, version: 1, created: true };
}

export async function findItemByName(
  exec: DbExec,
  libraryId: string,
  folderId: string | null,
  filename: string,
): Promise<LibraryItemRow | null> {
  const [row] = await exec
    .select()
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.libraryId, libraryId),
        folderId ? eq(libraryItems.folderId, folderId) : isNull(libraryItems.folderId),
        sql`lower(${libraryItems.filename}) = ${filename.trim().toLowerCase()}`,
      ),
    );
  return row ?? null;
}

export async function listItemVersions(itemId: string, limit = 100): Promise<LibraryVersionView[]> {
  const rows = await db
    .select({
      version: libraryVersions.version,
      filename: libraryVersions.filename,
      mimeType: libraryVersions.mimeType,
      size: libraryVersions.size,
      note: libraryVersions.note,
      origin: libraryVersions.origin,
      createdById: libraryVersions.createdById,
      creatorName: users.name,
      createdAt: libraryVersions.createdAt,
    })
    .from(libraryVersions)
    .leftJoin(users, eq(libraryVersions.createdById, users.id))
    .where(eq(libraryVersions.itemId, itemId))
    .orderBy(desc(libraryVersions.version))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map((r) => ({ ...r, origin: r.origin as LibraryOrigin }));
}

export async function getItemDetail(actorId: string, itemId: string): Promise<LibraryItemDetail> {
  const access = await requireLibraryItemAccess(actorId, itemId);
  const [versions, operations, links, folderRow] = await Promise.all([
    listItemVersions(itemId),
    listLibraryOperations(access.library.id, { itemId, limit: 100 }),
    db
      .select({
        id: librarySourceLinks.id,
        sourceType: librarySourceLinks.sourceType,
        sourceId: librarySourceLinks.sourceId,
        mode: librarySourceLinks.mode,
        origin: librarySourceLinks.origin,
        lastSourceVersion: librarySourceLinks.lastSourceVersion,
      })
      .from(librarySourceLinks)
      .where(eq(librarySourceLinks.itemId, itemId)),
    access.item.folderId
      ? db
          .select()
          .from(libraryFolders)
          .where(eq(libraryFolders.id, access.item.folderId))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
  ]);

  return {
    item: access.item,
    library: access.library,
    folder: folderRow,
    access,
    versions,
    operations,
    links,
    contentUrl: `/api/library/items/${itemId}/content`,
    currentContentUrl: `/api/library/items/${itemId}/content`,
  };
}

// ------------------------------------------------------------------ 条目写操作

function normalizeFilename(raw: string): string {
  const name = raw.trim().replace(/[\\/]/g, "");
  if (!name) throw new AppError("文件名不能为空");
  if (name.length > 200) throw new AppError("文件名不能超过 200 个字符");
  return name;
}

async function assertItemNameFree(
  libraryId: string,
  folderId: string | null,
  filename: string,
  exceptId?: string,
): Promise<void> {
  const [hit] = await db
    .select({ id: libraryItems.id })
    .from(libraryItems)
    .where(
      and(
        eq(libraryItems.libraryId, libraryId),
        folderId ? eq(libraryItems.folderId, folderId) : isNull(libraryItems.folderId),
        sql`lower(${libraryItems.filename}) = ${filename.toLowerCase()}`,
        exceptId ? sql`${libraryItems.id} <> ${exceptId}` : undefined,
      ),
    );
  if (hit) throw new AppError("目标位置已有同名文件");
}

export async function renameLibraryItem(
  actorId: string,
  itemId: string,
  rawName: string,
): Promise<void> {
  const access = await requireLibraryItemEdit(actorId, itemId);
  const filename = normalizeFilename(rawName);
  await assertItemNameFree(access.library.id, access.item.folderId, filename, itemId);

  await db.transaction(async (tx) => {
    await tx
      .update(libraryItems)
      .set({ filename, updatedAt: sql`now()` })
      .where(eq(libraryItems.id, itemId));
    await tx
      .update(documents)
      .set({ filename, updatedAt: sql`now()` })
      .where(and(eq(documents.sourceType, "library_item"), eq(documents.sourceId, itemId)));
    await recordLibraryOperation(tx, {
      libraryId: access.library.id,
      itemId,
      actorId,
      type: "item_renamed",
      oldValue: access.item.filename,
      newValue: filename,
    });
  });
}

export async function moveLibraryItem(
  actorId: string,
  itemId: string,
  folderId: string | null,
): Promise<void> {
  const access = await requireLibraryItemEdit(actorId, itemId);
  // null = 移到资源库根目录，没有文件夹可校验
  if (folderId) await assertFolderInLibrary(db, access.library.id, folderId);
  await assertItemNameFree(access.library.id, folderId, access.item.filename, itemId);
  await db.transaction(async (tx) => {
    await tx
      .update(libraryItems)
      .set({ folderId, updatedAt: sql`now()` })
      .where(eq(libraryItems.id, itemId));
    await recordLibraryOperation(tx, {
      libraryId: access.library.id,
      itemId,
      folderId,
      actorId,
      type: "item_moved",
      oldValue: access.item.folderId,
      newValue: folderId,
    });
  });
}

/** 在线编辑 live 条目时停止跟随来源，避免下一次同步把用户编辑内容打乱 */
export async function detachLiveLinksForEdit(
  exec: DbExec,
  itemId: string,
  actorId: string,
): Promise<void> {
  const links = await exec
    .select({ id: librarySourceLinks.id })
    .from(librarySourceLinks)
    .where(and(eq(librarySourceLinks.itemId, itemId), eq(librarySourceLinks.mode, "live")));
  if (links.length === 0) return;
  await exec
    .update(librarySourceLinks)
    .set({ mode: "snapshot", updatedAt: sql`now()` })
    .where(and(eq(librarySourceLinks.itemId, itemId), eq(librarySourceLinks.mode, "live")));
  const [item] = await exec
    .select({ libraryId: libraryItems.libraryId, filename: libraryItems.filename })
    .from(libraryItems)
    .where(eq(libraryItems.id, itemId));
  if (item) {
    await recordLibraryOperation(exec, {
      libraryId: item.libraryId,
      itemId,
      actorId,
      type: "live_follow_detached",
      newValue: item.filename,
      note: "在线编辑后停止跟随来源",
    });
  }
}

export async function deleteLibraryVersion(
  actorId: string,
  itemId: string,
  version: number,
): Promise<void> {
  const access = await requireLibraryItemEdit(actorId, itemId);
  if (version === access.item.currentVersion)
    throw new AppError("当前版本不能删除，请先恢复或保存新版本");

  const [row] = await db
    .select({ storageKey: libraryVersions.storageKey })
    .from(libraryVersions)
    .where(and(eq(libraryVersions.itemId, itemId), eq(libraryVersions.version, version)));
  if (!row) throw new AppError("版本不存在");

  const [countRow] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(libraryVersions)
    .where(eq(libraryVersions.itemId, itemId));
  if (Number(countRow?.n ?? 0) <= 1) throw new AppError("至少保留一个版本");

  await db.transaction(async (tx) => {
    await tx
      .delete(libraryVersions)
      .where(and(eq(libraryVersions.itemId, itemId), eq(libraryVersions.version, version)));
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.sourceType, "library_item"), eq(documents.sourceId, itemId)));
    if (doc) {
      await tx
        .delete(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, doc.id),
            eq(documentVersions.version, version),
          ),
        );
    }
    await recordLibraryOperation(tx, {
      libraryId: access.library.id,
      itemId,
      actorId,
      type: "version_deleted",
      newValue: access.item.filename,
      note: `v${version}`,
    });
  });

  await deleteBlobIfUnreferenced(row.storageKey);
}

/**
 * 删除资源库条目。默认只删资源库记录；显式 deleteSources 时只删「当前操作者
 * 有权删除」的来源——任务附件与助手文件；私信/群聊附件按现有永久留存设计跳过。
 */
export async function deleteLibraryItem(
  actorId: string,
  itemId: string,
  opts: { deleteSources?: boolean } = {},
): Promise<{ deletedSources: string[]; skippedSources: string[] }> {
  const access = await requireLibraryItemAccess(actorId, itemId);
  if (!access.canEdit) throw new ForbiddenError("你没有该资源库文件的编辑权限");

  const [versions, links] = await Promise.all([
    db
      .select({ storageKey: libraryVersions.storageKey })
      .from(libraryVersions)
      .where(eq(libraryVersions.itemId, itemId)),
    db
      .select({
        sourceType: librarySourceLinks.sourceType,
        sourceId: librarySourceLinks.sourceId,
      })
      .from(librarySourceLinks)
      .where(eq(librarySourceLinks.itemId, itemId)),
  ]);

  await db.transaction(async (tx) => {
    // 资源库条目的文档行没有 taskId 锚点，必须手动清理
    await tx
      .delete(documents)
      .where(and(eq(documents.sourceType, "library_item"), eq(documents.sourceId, itemId)));
    await tx.delete(libraryItems).where(eq(libraryItems.id, itemId));
    await recordLibraryOperation(tx, {
      libraryId: access.library.id,
      itemId: null,
      actorId,
      type: "item_deleted",
      newValue: access.item.filename,
      note: opts.deleteSources ? "同时删除来源文件" : "仅删除资源库记录",
    });
  });

  for (const v of versions) await deleteBlobIfUnreferenced(v.storageKey);

  const deletedSources: string[] = [];
  const skippedSources: string[] = [];
  if (opts.deleteSources) {
    for (const link of links) {
      const key = `${link.sourceType}:${link.sourceId}`;
      try {
        if (link.sourceType === "task_attachment") {
          await deleteAttachment(actorId, link.sourceId);
          deletedSources.push(key);
        } else if (link.sourceType === "agent_file") {
          await deleteAgentFile(actorId, link.sourceId);
          deletedSources.push(key);
        } else {
          skippedSources.push(key);
        }
      } catch {
        skippedSources.push(key);
      }
    }
  }

  return { deletedSources, skippedSources };
}

/** 保留最新 50 + v1（排除当前版本），与文档版本策略一致 */
export async function pruneLibraryItemVersions(itemId: string): Promise<void> {
  const rows = await db
    .select({ version: libraryVersions.version, storageKey: libraryVersions.storageKey })
    .from(libraryVersions)
    .where(eq(libraryVersions.itemId, itemId))
    .orderBy(desc(libraryVersions.version));
  if (rows.length <= VERSION_KEEP_TOTAL) return;

  const [item] = await db
    .select({ currentVersion: libraryItems.currentVersion })
    .from(libraryItems)
    .where(eq(libraryItems.id, itemId));
  if (!item) return;

  const keep = new Set<number>([1, item.currentVersion]);
  for (const row of rows.slice(0, VERSION_KEEP_LATEST)) keep.add(row.version);
  const drop = rows.filter((r) => !keep.has(r.version));
  if (drop.length === 0) return;

  await db.transaction(async (tx) => {
    await tx
      .delete(libraryVersions)
      .where(
        and(
          eq(libraryVersions.itemId, itemId),
          sql`${libraryVersions.version} in (${sql.join(
            drop.map((d) => sql`${d.version}`),
            sql`, `,
          )})`,
        ),
      );
    const [doc] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.sourceType, "library_item"), eq(documents.sourceId, itemId)));
    if (doc) {
      await tx
        .delete(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, doc.id),
            sql`${documentVersions.version} in (${sql.join(
              drop.map((d) => sql`${d.version}`),
              sql`, `,
            )})`,
          ),
        );
    }
  });

  for (const row of drop) await deleteBlobIfUnreferenced(row.storageKey);
}
