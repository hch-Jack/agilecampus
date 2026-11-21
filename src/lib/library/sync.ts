import { and, asc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  agentFiles,
  dmAttachments,
  dmGroupMessages,
  dmMessages,
  documents,
  documentVersions,
  libraries,
  libraryItems,
  librarySourceLinks,
  libraryVersions,
  projects,
  taskAttachments,
  tasks,
} from "@/db/schema";
import type { DbTx } from "@/db";
import { MAX_FILE_SIZE } from "@/lib/file-limits";
import { saveBlobFromBuffer, readStoredContent } from "@/lib/blob-store";
import { AppError, ForbiddenError } from "@/lib/errors";
import { getTeamMembership } from "@/lib/team";
import { ensureLibrary } from "./folders";
import { appendLibraryVersion, putVersionByName } from "./versions";
import type {
  DefaultFolderKey,
  LibraryOrigin,
  LibraryRef,
  LibraryRow,
  LibraryVersionNote,
} from "./types";

const SYNC_THROTTLE_MS = 15_000;

type SourceFile = {
  storageKey: string | null;
  data?: Buffer | null;
  filename: string;
  mimeType: string | null;
  size: number;
  createdAt: Date;
  actorId: string | null;
};

type SyncStats = { imported: number; versions: number; skipped: boolean };

async function applyLibrarySync(
  library: LibraryRow,
  opts: { force?: boolean },
  fn: (tx: DbTx, createdBlobs: string[]) => Promise<void>,
): Promise<SyncStats> {
  const createdBlobs: string[] = [];
  const stats: SyncStats = { imported: 0, versions: 0, skipped: true };

  try {
    await db.transaction(async (tx) => {
      // 阻塞式事务锁：并发打开资源库时后到者等前一轮同步提交，避免读到半套数据
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${library.id})::bigint)`,
      );

      if (!opts.force) {
        const [row] = await tx
          .select({ lastSyncedAt: libraries.lastSyncedAt })
          .from(libraries)
          .where(eq(libraries.id, library.id));
        const last = row?.lastSyncedAt ? new Date(row.lastSyncedAt).getTime() : 0;
        if (last && Date.now() - last < SYNC_THROTTLE_MS) return;
      }

      stats.skipped = false;
      await fn(tx, createdBlobs);
      await tx
        .update(libraries)
        .set({ lastSyncedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(libraries.id, library.id));
    });
  } catch (e) {
    for (const key of createdBlobs) {
      await import("@/lib/blob-store").then((m) => m.deleteBlob(key)).catch(() => {});
    }
    throw e;
  }
  return stats;
}

function noteOfDocument(note: string | null): LibraryVersionNote {
  // 文档版本的 note 是自由文本；资源库只保留已知几类，其余归为 sync
  switch (note) {
    case "initial":
      return "initial";
    case "autosave":
      return "autosave";
    case "manual":
      return "manual";
    case "restore":
      return "restore";
    case "save_as":
      return "save_as";
    default:
      return "sync";
  }
}

async function materialize(
  tx: DbTx,
  createdBlobs: string[],
  file: SourceFile,
): Promise<{ storageKey: string; size: number }> {
  if (file.storageKey) return { storageKey: file.storageKey, size: file.size };
  const data = await readStoredContent({ data: file.data, storageKey: null }, MAX_FILE_SIZE);
  const saved = await saveBlobFromBuffer(data, MAX_FILE_SIZE);
  createdBlobs.push(saved.storageKey);
  return { storageKey: saved.storageKey, size: saved.size };
}

// ------------------------------------------------------------------ 任务附件

async function syncTaskAttachment(
  tx: DbTx,
  createdBlobs: string[],
  opts: {
    library: LibraryRow;
    folderId: string;
    attachment: SourceFile & { id: string };
    mode: "live" | "snapshot";
  },
): Promise<number> {
  const [link] = await tx
    .select()
    .from(librarySourceLinks)
    .where(
      and(
        eq(librarySourceLinks.libraryId, opts.library.id),
        eq(librarySourceLinks.sourceType, "task_attachment"),
        eq(librarySourceLinks.sourceId, opts.attachment.id),
      ),
    );

  const [doc] = await tx
    .select({ id: documents.id, currentVersion: documents.currentVersion })
    .from(documents)
    .where(
      and(
        eq(documents.sourceType, "task_attachment"),
        eq(documents.sourceId, opts.attachment.id),
      ),
    );

  if (!link) {
    let count = 0;
    let importedItemId: string | null = null;
    if (doc) {
      const versions = await tx
        .select()
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id))
        .orderBy(asc(documentVersions.version));
      for (const v of versions) {
        const res = await putVersionByName(tx, {
          library: opts.library,
          folderId: opts.folderId,
          filename: v.filename,
          mimeType: v.mimeType,
          storageKey: v.storageKey,
          size: v.size,
          editorState: v.editorState,
          note: noteOfDocument(v.note),
          origin: "task",
          createdById: v.createdById ?? opts.attachment.actorId,
          operationType: "item_imported",
          operationNote: `v${v.version}`,
          createdAt: v.createdAt,
          sourceKey: `task_attachment:${opts.attachment.id}:${v.version}`,
        });
        importedItemId = res.itemId;
        count++;
      }
    }
    if (!importedItemId) {
      const ref = await materialize(tx, createdBlobs, opts.attachment);
      const res = await putVersionByName(tx, {
        library: opts.library,
        folderId: opts.folderId,
        filename: opts.attachment.filename,
        mimeType: opts.attachment.mimeType,
        storageKey: ref.storageKey,
        size: ref.size,
        note: "import",
        origin: "task",
        createdById: opts.attachment.actorId,
        operationType: "item_imported",
        createdAt: opts.attachment.createdAt,
        sourceKey: `task_attachment:${opts.attachment.id}:1`,
      });
      importedItemId = res.itemId;
      count = 1;
    }
    await tx.insert(librarySourceLinks).values({
      libraryId: opts.library.id,
      itemId: importedItemId,
      sourceType: "task_attachment",
      sourceId: opts.attachment.id,
      mode: opts.mode,
      origin: "task",
      // 首次导入时没有文档行：当前附件内容已经作为 v1 入库，后续只看 v2+
      lastSourceVersion: doc?.currentVersion ?? 1,
      lastSyncedStorageKey: opts.attachment.storageKey,
      lastSyncedAt: sql`now()`,
      createdById: opts.attachment.actorId,
    });
    return count;
  }

  if (link.mode !== "live") return 0;

  // live：只补 lastSourceVersion 之后的文档版本
  let count = 0;
  if (doc) {
    const existingKeys = new Set(
      (
        await tx
          .select({ storageKey: libraryVersions.storageKey })
          .from(libraryVersions)
          .where(eq(libraryVersions.itemId, link.itemId))
      ).map((v) => v.storageKey),
    );
    const versions = await tx
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, doc.id),
          sql`${documentVersions.version} > ${link.lastSourceVersion ?? 0}`,
        ),
      )
      .orderBy(asc(documentVersions.version));
    for (const v of versions) {
      // v1 可能与附件/既有版本共用同一个 blob：同 key 已存在就不再重复记版本
      if (existingKeys.has(v.storageKey)) continue;
      existingKeys.add(v.storageKey);
      await appendLibraryVersion(tx, link.itemId, {
        storageKey: v.storageKey,
        size: v.size,
        mimeType: v.mimeType,
        filename: v.filename,
        editorState: v.editorState,
        note: noteOfDocument(v.note),
        origin: "task",
        createdById: v.createdById ?? opts.attachment.actorId,
        operationType: "version_synced",
        operationNote: `源 v${v.version}`,
        createdAt: v.createdAt,
        sourceKey: `task_attachment:${opts.attachment.id}:${v.version}`,
      });
      count++;
    }
    await tx
      .update(librarySourceLinks)
      .set({
        lastSourceVersion: doc.currentVersion,
        lastSyncedStorageKey: opts.attachment.storageKey,
        lastSyncedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(librarySourceLinks.id, link.id));
  } else if (
    opts.attachment.storageKey &&
    link.lastSyncedStorageKey !== opts.attachment.storageKey
  ) {
    // 没有在线编辑历史，但附件本身被替换（老数据/外部写入）时也跟进一次
    await appendLibraryVersion(tx, link.itemId, {
      storageKey: opts.attachment.storageKey,
      size: opts.attachment.size,
      mimeType: opts.attachment.mimeType,
      filename: opts.attachment.filename,
      note: "sync",
      origin: "task",
      createdById: opts.attachment.actorId,
      operationType: "version_synced",
      createdAt: opts.attachment.createdAt,
      sourceKey: `task_attachment:${opts.attachment.id}:${opts.attachment.storageKey}`,
    });
    await tx
      .update(librarySourceLinks)
      .set({
        lastSyncedStorageKey: opts.attachment.storageKey,
        lastSyncedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(librarySourceLinks.id, link.id));
    count++;
  }
  return count;
}

// ------------------------------------------------------------------ 不可变来源（私信 / 助手）

async function syncImmutableSource(
  tx: DbTx,
  createdBlobs: string[],
  opts: {
    library: LibraryRow;
    folderId: string;
    attachment: SourceFile & { id: string };
    sourceType: "dm_attachment" | "agent_file";
    origin: LibraryOrigin;
  },
): Promise<number> {
  const [link] = await tx
    .select()
    .from(librarySourceLinks)
    .where(
      and(
        eq(librarySourceLinks.libraryId, opts.library.id),
        eq(librarySourceLinks.sourceType, opts.sourceType),
        eq(librarySourceLinks.sourceId, opts.attachment.id),
      ),
    );
  if (link) return 0;

  const ref = await materialize(tx, createdBlobs, opts.attachment);
  const res = await putVersionByName(tx, {
    library: opts.library,
    folderId: opts.folderId,
    filename: opts.attachment.filename,
    mimeType: opts.attachment.mimeType,
    storageKey: ref.storageKey,
    size: ref.size,
    note: "import",
    origin: opts.origin,
    createdById: opts.attachment.actorId,
    operationType: "item_imported",
    sourceKey: `${opts.sourceType}:${opts.attachment.id}`,
  });
  await tx.insert(librarySourceLinks).values({
    libraryId: opts.library.id,
    itemId: res.itemId,
    sourceType: opts.sourceType,
    sourceId: opts.attachment.id,
    mode: "snapshot",
    origin: opts.origin,
    lastSyncedStorageKey: ref.storageKey,
    lastSyncedAt: sql`now()`,
    createdById: opts.attachment.actorId,
  });
  return 1;
}

// ------------------------------------------------------------------ live 群文件同名接续

async function syncLiveGroupLinks(
  tx: DbTx,
  library: LibraryRow,
  createdBlobs: string[],
): Promise<number> {
  const links = await tx
    .select({
      id: librarySourceLinks.id,
      itemId: librarySourceLinks.itemId,
      sourceId: librarySourceLinks.sourceId,
    })
    .from(librarySourceLinks)
    .where(
      and(
        eq(librarySourceLinks.libraryId, library.id),
        eq(librarySourceLinks.origin, "group"),
        eq(librarySourceLinks.mode, "live"),
      ),
    );
  let count = 0;
  for (const link of links) {
    const [item] = await tx
      .select({ filename: libraryItems.filename })
      .from(libraryItems)
      .where(eq(libraryItems.id, link.itemId));
    if (!item) continue;
    const [originMsg] = await tx
      .select({ groupId: dmGroupMessages.groupId })
      .from(dmGroupMessages)
      .where(eq(dmGroupMessages.attachmentId, link.sourceId));
    if (!originMsg) continue;

    const rows = await tx
      .select({
        id: dmAttachments.id,
        filename: dmAttachments.filename,
        mimeType: dmAttachments.mimeType,
        size: dmAttachments.size,
        storageKey: dmAttachments.storageKey,
        data: dmAttachments.data,
        createdAt: dmAttachments.createdAt,
        senderId: dmGroupMessages.senderId,
      })
      .from(dmGroupMessages)
      .innerJoin(dmAttachments, eq(dmGroupMessages.attachmentId, dmAttachments.id))
      .where(
        and(
          eq(dmGroupMessages.groupId, originMsg.groupId),
          sql`lower(${dmAttachments.filename}) = ${item.filename.trim().toLowerCase()}`,
        ),
      )
      .orderBy(asc(dmGroupMessages.createdAt));

    const existing = await tx
      .select({
        storageKey: libraryVersions.storageKey,
        sourceKey: libraryVersions.sourceKey,
      })
      .from(libraryVersions)
      .where(eq(libraryVersions.itemId, link.itemId));
    const seen = new Set(existing.map((v) => v.storageKey));
    const seenSource = new Set(existing.map((v) => v.sourceKey).filter(Boolean));

    for (const row of rows) {
      const sourceKey = `dm_attachment:${row.id}`;
      if (seenSource.has(sourceKey)) continue;
      // 群附件大多是库内 bytea：先物化/复用 key，再按 key 去重
      const ref = await materialize(tx, createdBlobs, {
        storageKey: row.storageKey,
        data: row.data,
        filename: row.filename,
        mimeType: row.mimeType,
        size: row.size,
        createdAt: row.createdAt,
        actorId: row.senderId,
      });
      if (seen.has(ref.storageKey)) {
        seenSource.add(sourceKey);
        continue;
      }
      await appendLibraryVersion(tx, link.itemId, {
        storageKey: ref.storageKey,
        size: ref.size,
        mimeType: row.mimeType,
        filename: row.filename,
        note: "sync",
        origin: "group",
        createdById: row.senderId,
        operationType: "version_synced",
        operationNote: "同群同名新附件",
        createdAt: row.createdAt,
        sourceKey,
      });
      seen.add(ref.storageKey);
      seenSource.add(sourceKey);
      count++;
    }
    await tx
      .update(librarySourceLinks)
      .set({ lastSyncedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(librarySourceLinks.id, link.id));
  }
  return count;
}

// ------------------------------------------------------------------ 入口

async function defaultFolderMap(
  library: LibraryRow,
): Promise<Partial<Record<DefaultFolderKey, string>>> {
  const { ensureDefaultFolders } = await import("./folders");
  return ensureDefaultFolders(library);
}

function folderOf(
  folders: Partial<Record<DefaultFolderKey, string>>,
  key: DefaultFolderKey,
): string {
  const id = folders[key];
  if (!id) throw new AppError("资源库默认文件夹缺失");
  return id;
}

export async function syncPersonalLibrary(
  userId: string,
  opts: { force?: boolean } = {},
): Promise<SyncStats> {
  const ref: LibraryRef = { kind: "personal", userId };
  const library = await ensureLibrary(ref);
  const folders = await defaultFolderMap(library);

  return applyLibrarySync(library, opts, async (tx, createdBlobs) => {
    const taskRows = await tx
      .select({
        id: taskAttachments.id,
        filename: taskAttachments.filename,
        mimeType: taskAttachments.mimeType,
        size: taskAttachments.size,
        storageKey: taskAttachments.storageKey,
        data: taskAttachments.data,
        createdAt: taskAttachments.createdAt,
        actorId: taskAttachments.uploaderId,
      })
      .from(taskAttachments)
      .where(eq(taskAttachments.uploaderId, userId))
      .orderBy(asc(taskAttachments.createdAt));
    for (const row of taskRows) {
      await syncTaskAttachment(tx, createdBlobs, {
        library,
        folderId: folderOf(folders, "task"),
        attachment: row,
        mode: "live",
      });
    }

    const dmRows = await tx
      .select({
        id: dmAttachments.id,
        filename: dmAttachments.filename,
        mimeType: dmAttachments.mimeType,
        size: dmAttachments.size,
        storageKey: dmAttachments.storageKey,
        data: dmAttachments.data,
        createdAt: dmAttachments.createdAt,
        actorId: dmAttachments.uploaderId,
      })
      .from(dmAttachments)
      .innerJoin(dmMessages, eq(dmMessages.attachmentId, dmAttachments.id))
      .where(
        or(eq(dmMessages.senderId, userId), eq(dmMessages.recipientId, userId)),
      )
      .orderBy(asc(dmAttachments.createdAt));
    const seenDm = new Set<string>();
    for (const row of dmRows) {
      if (seenDm.has(row.id)) continue;
      seenDm.add(row.id);
      await syncImmutableSource(tx, createdBlobs, {
        library,
        folderId: folderOf(folders, "dm"),
        attachment: row,
        sourceType: "dm_attachment",
        origin: "dm",
      });
    }

    const agentRows = await tx
      .select({
        id: agentFiles.id,
        filename: agentFiles.filename,
        mimeType: agentFiles.mimeType,
        size: agentFiles.size,
        storageKey: agentFiles.storageKey,
        data: agentFiles.data,
        createdAt: agentFiles.createdAt,
        actorId: agentFiles.ownerId,
      })
      .from(agentFiles)
      .where(eq(agentFiles.ownerId, userId))
      .orderBy(asc(agentFiles.createdAt));
    for (const row of agentRows) {
      await syncImmutableSource(tx, createdBlobs, {
        library,
        folderId: folderOf(folders, "agent"),
        attachment: row,
        sourceType: "agent_file",
        origin: "agent",
      });
    }

    await syncLiveGroupLinks(tx, library, createdBlobs);
  });
}

export async function syncTeamLibrary(
  actorId: string,
  teamId: string,
  opts: { force?: boolean } = {},
): Promise<SyncStats> {
  const membership = await getTeamMembership(actorId, teamId);
  if (!membership) throw new ForbiddenError("你不是该团队成员");
  const ref: LibraryRef = { kind: "team", teamId };
  const library = await ensureLibrary(ref);
  const folders = await defaultFolderMap(library);

  return applyLibrarySync(library, opts, async (tx, createdBlobs) => {
    const rows = await tx
      .select({
        id: taskAttachments.id,
        filename: taskAttachments.filename,
        mimeType: taskAttachments.mimeType,
        size: taskAttachments.size,
        storageKey: taskAttachments.storageKey,
        data: taskAttachments.data,
        createdAt: taskAttachments.createdAt,
        actorId: taskAttachments.uploaderId,
      })
      .from(taskAttachments)
      .innerJoin(tasks, eq(taskAttachments.taskId, tasks.id))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(eq(projects.teamId, teamId))
      .orderBy(asc(taskAttachments.createdAt));
    for (const row of rows) {
      await syncTaskAttachment(tx, createdBlobs, {
        library,
        folderId: folderOf(folders, "task"),
        attachment: row,
        mode: "live",
      });
    }
    await syncLiveGroupLinks(tx, library, createdBlobs);
  });
}
