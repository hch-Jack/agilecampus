import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dmAttachments,
  dmGroupMembers,
  dmGroupMessages,
  libraryItems,
  librarySourceLinks,
  users,
} from "@/db/schema";
import { AppError, ForbiddenError } from "@/lib/errors";
import { readStoredContent, saveBlobFromBuffer } from "@/lib/blob-store";
import { MAX_FILE_SIZE } from "@/lib/file-limits";
import { assertFolderInLibrary, getLibraryAccess } from "./library/access";
import { ensureLibrary, getDefaultFolderId } from "./library/folders";
import { putVersionByName } from "./library/versions";
import type { LibraryRef, LibrarySyncMode } from "./library/types";

export type GroupFileView = {
  attachmentId: string;
  filename: string;
  mimeType: string | null;
  size: number;
  messageId: string;
  senderId: string;
  senderName: string;
  createdAt: string;
};

async function assertGroupMember(actorId: string, groupId: string): Promise<void> {
  const [member] = await db
    .select({ id: dmGroupMembers.id })
    .from(dmGroupMembers)
    .where(and(eq(dmGroupMembers.groupId, groupId), eq(dmGroupMembers.userId, actorId)));
  if (!member) throw new ForbiddenError("你不是该群成员");
}

/** 群文件：本群所有带附件消息里的文件（同一附件只出现一次） */
export async function listGroupFiles(
  actorId: string,
  groupId: string,
): Promise<GroupFileView[]> {
  await assertGroupMember(actorId, groupId);

  const rows = await db
    .select({
      attachmentId: dmAttachments.id,
      filename: dmAttachments.filename,
      mimeType: dmAttachments.mimeType,
      size: dmAttachments.size,
      messageId: dmGroupMessages.id,
      senderId: dmGroupMessages.senderId,
      senderName: users.name,
      createdAt: dmGroupMessages.createdAt,
    })
    .from(dmGroupMessages)
    .innerJoin(dmAttachments, eq(dmGroupMessages.attachmentId, dmAttachments.id))
    .leftJoin(users, eq(dmGroupMessages.senderId, users.id))
    .where(eq(dmGroupMessages.groupId, groupId))
    .orderBy(desc(dmGroupMessages.createdAt));

  const seen = new Set<string>();
  const out: GroupFileView[] = [];
  for (const row of rows) {
    if (seen.has(row.attachmentId)) continue;
    seen.add(row.attachmentId);
    out.push({
      ...row,
      senderName: row.senderName ?? "群成员",
      createdAt: row.createdAt.toISOString(),
    });
  }
  return out;
}

/**
 * 把群文件同步到个人/团队资源库。重复点击幂等：
 * 同一库内同一来源只保留一条链接，已存在时只更新模式，不再追加版本。
 */
export async function syncGroupFileToLibrary(input: {
  actorId: string;
  groupId: string;
  attachmentId: string;
  target: LibraryRef;
  folderId?: string | null;
  mode: LibrarySyncMode;
}): Promise<{ itemId: string; version: number; created: boolean }> {
  await assertGroupMember(input.actorId, input.groupId);

  const [message] = await db
    .select({ id: dmGroupMessages.id })
    .from(dmGroupMessages)
    .where(
      and(
        eq(dmGroupMessages.groupId, input.groupId),
        eq(dmGroupMessages.attachmentId, input.attachmentId),
      ),
    )
    .limit(1);
  if (!message) throw new AppError("文件不属于该群");

  const [att] = await db
    .select()
    .from(dmAttachments)
    .where(eq(dmAttachments.id, input.attachmentId));
  if (!att) throw new AppError("文件不存在");

  const library = await ensureLibrary(input.target);
  const access = await getLibraryAccess(input.actorId, input.target);
  if (!access?.canEdit) throw new ForbiddenError("你没有目标资源库的编辑权限");

  const folderId = input.folderId || (await getDefaultFolderId(library, "group"));
  await assertFolderInLibrary(db, library.id, folderId);

  const [link] = await db
    .select()
    .from(librarySourceLinks)
    .where(
      and(
        eq(librarySourceLinks.libraryId, library.id),
        eq(librarySourceLinks.sourceType, "dm_attachment"),
        eq(librarySourceLinks.sourceId, input.attachmentId),
      ),
    );

  if (link) {
    if (link.mode !== input.mode) {
      await db
        .update(librarySourceLinks)
        .set({ mode: input.mode, updatedAt: sql`now()` })
        .where(eq(librarySourceLinks.id, link.id));
    }
    const [item] = await db
      .select({ currentVersion: libraryItems.currentVersion })
      .from(libraryItems)
      .where(eq(libraryItems.id, link.itemId));
    return {
      itemId: link.itemId,
      version: item?.currentVersion ?? 1,
      created: false,
    };
  }

  let storageKey = att.storageKey;
  let size = att.size;
  if (!storageKey) {
    const data = await readStoredContent(
      { data: att.data, storageKey: null },
      MAX_FILE_SIZE,
    );
    const saved = await saveBlobFromBuffer(data, MAX_FILE_SIZE);
    storageKey = saved.storageKey;
    size = saved.size;
  }

  return db.transaction(async (tx) => {
    const res = await putVersionByName(tx, {
      library,
      folderId,
      filename: att.filename,
      mimeType: att.mimeType,
      storageKey,
      size,
      note: "import",
      origin: "group",
      createdById: input.actorId,
      operationType: "item_synced",
      operationNote: input.mode === "live" ? "实时跟进" : "仅当前版本",
      sourceKey: `dm_attachment:${input.attachmentId}`,
    });
    await tx.insert(librarySourceLinks).values({
      libraryId: library.id,
      itemId: res.itemId,
      sourceType: "dm_attachment",
      sourceId: input.attachmentId,
      mode: input.mode,
      origin: "group",
      lastSyncedStorageKey: storageKey,
      lastSyncedAt: sql`now()`,
      createdById: input.actorId,
    });
    return res;
  });
}
