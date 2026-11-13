import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  documentEditors,
  documentVersions,
  documents,
  teamMembers,
  users,
  type TeamRole,
} from "@/db/schema";
import { saveBlobFromBuffer, readBlob, deleteBlob } from "@/lib/blob-store";
import { AppError, ForbiddenError, VersionConflictError } from "@/lib/errors";
import {
  assertTeamMemberForDocument,
  getDocumentAccess,
  requireDocumentAccess,
  requireDocumentEdit,
  requireDocumentManage,
} from "./access";
import { deleteLocksForDocument, deleteLockForUser, getLockView, assertLockHeld } from "./locks";
import { getDocumentSourceAdapter, hasDocumentSourceAdapter } from "./registry";
import { broadcast, broadcastPresence } from "./events";
import { deleteBlobIfUnreferenced, pruneDocumentVersions } from "./blobs";
import {
  DOCX_EDIT_MAX_BYTES,
  SHEET_EDIT_MAX_BYTES,
  TEXT_EDIT_MAX_BYTES,
  isSameEditableFormat,
} from "./format";
import type { DbExec, DocumentAccess, DocumentFormat } from "./types";

/** 新建/打开文档：懒创建 documents 行，唯一键保证一个来源只有一条 */
export async function ensureDocument(
  userId: string,
  sourceType: string,
  sourceId: string,
): Promise<DocumentAccess> {
  if (!hasDocumentSourceAdapter(sourceType)) throw new AppError("不支持的文档来源");
  const adapter = getDocumentSourceAdapter(sourceType);
  const source = await adapter.load(userId, sourceId);
  if (!source) {
    throw new ForbiddenError("文档不存在、你没有访问权限，或该格式不支持在线编辑");
  }

  const [existing] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.sourceType, sourceType), eq(documents.sourceId, sourceId)));

  if (!existing) {
    await db
      .insert(documents)
      .values({
        sourceType,
        sourceId,
        taskId: source.taskId,
        format: source.format,
        filename: source.filename,
        mimeType: source.mimeType,
        createdById: userId,
      })
      .onConflictDoNothing({
        target: [documents.sourceType, documents.sourceId],
      });
  }

  const access = await getDocumentAccessBySource(userId, sourceType, sourceId);
  if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
  return access;
}

async function getDocumentAccessBySource(
  userId: string,
  sourceType: string,
  sourceId: string,
): Promise<DocumentAccess | null> {
  const [doc] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.sourceType, sourceType), eq(documents.sourceId, sourceId)));
  if (!doc) return null;
  return getDocumentAccess(doc.id, userId);
}

export function maxBytesForFormat(format: DocumentFormat): number {
  switch (format) {
    case "text":
      return TEXT_EDIT_MAX_BYTES;
    case "docx":
      return DOCX_EDIT_MAX_BYTES;
    case "sheet":
      return SHEET_EDIT_MAX_BYTES;
  }
}

export async function readDocumentContent(
  documentId: string,
  userId: string,
  version?: number,
): Promise<{ data: Buffer; filename: string; mimeType: string | null; size: number; version: number }> {
  const access = await requireDocumentAccess(documentId, userId);
  if (version && version !== access.document.currentVersion) {
    const [row] = await db
      .select({
        storageKey: documentVersions.storageKey,
        filename: documentVersions.filename,
        mimeType: documentVersions.mimeType,
        size: documentVersions.size,
      })
      .from(documentVersions)
      .where(
        and(eq(documentVersions.documentId, documentId), eq(documentVersions.version, version)),
      );
    if (!row) throw new AppError("版本不存在");
    const data = await readBlob(row.storageKey, maxBytesForFormat(access.document.format));
    return {
      data,
      filename: row.filename,
      mimeType: row.mimeType,
      size: data.length,
      version,
    };
  }

  const adapter = getDocumentSourceAdapter(access.document.sourceType);
  const content = await adapter.read(
    access.source,
    maxBytesForFormat(access.document.format),
  );
  return {
    data: content.data,
    filename: content.filename,
    mimeType: content.mimeType,
    size: content.size,
    version: access.document.currentVersion,
  };
}

export type SaveInput = {
  documentId: string;
  userId: string;
  sessionId: string;
  baseVersion: number;
  force?: boolean;
  bytes: Buffer;
  mimeType: string | null;
  editorState?: unknown;
  note?: "autosave" | "manual" | "restore";
};

/**
 * 保存到原文件。
 *
 * blob 先落盘、事务失败即删；文档行 `FOR UPDATE` 串行化保存/开关切换；
 * 单人模式在事务内再次校验锁；版本号条件更新是真正的乐观锁。
 */
export async function saveDocument(input: SaveInput): Promise<{ version: number; size: number }> {
  const access = await requireDocumentEdit(input.documentId, input.userId);
  const maxBytes = maxBytesForFormat(access.document.format);
  if (input.bytes.length === 0) throw new AppError("不能保存空文档");
  if (input.bytes.length > maxBytes) throw new AppError("文档超过在线编辑大小上限");

  const blob = await saveBlobFromBuffer(input.bytes, maxBytes);
  const adapter = getDocumentSourceAdapter(access.document.sourceType);

  try {
    const result = await db.transaction(async (tx) => {
      const [doc] = await tx
        .select()
        .from(documents)
        .where(eq(documents.id, input.documentId))
        .for("update");
      if (!doc) throw new AppError("文档不存在");

      // 事务内复核额外授权：撤销授权与保存并发时，保存必须失败
      if (!access.canManage) {
        const [grant] = await tx
          .select({ userId: documentEditors.userId })
          .from(documentEditors)
          .where(
            and(
              eq(documentEditors.documentId, input.documentId),
              eq(documentEditors.userId, input.userId),
            ),
          );
        if (!grant) throw new ForbiddenError("编辑权限已被收回");
      }

      if (!doc.collaborationEnabled) {
        await assertLockHeld(tx, input.documentId, input.userId, input.sessionId);
      }

      if (!input.force && doc.currentVersion !== input.baseVersion) {
        throw new VersionConflictError("文档已被其他人保存", doc.currentVersion);
      }

      // 首次保存前把原始内容固化为 v1（磁盘 key 直接复用；历史 bytea 物化）
      await ensureInitialVersion(tx, doc, access, adapter, input.userId);

      const expected = doc.currentVersion;
      const [updated] = await tx
        .update(documents)
        .set({
          currentVersion: sql`${documents.currentVersion} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(documents.id, input.documentId), eq(documents.currentVersion, expected)))
        .returning({ currentVersion: documents.currentVersion });
      if (!updated) {
        throw new VersionConflictError("文档已被其他人保存", doc.currentVersion);
      }

      const nowFilename = access.document.filename;
      await adapter.replace(tx, access.source, {
        storageKey: blob.storageKey,
        size: blob.size,
        mimeType: input.mimeType,
        filename: nowFilename,
      });

      await tx.insert(documentVersions).values({
        documentId: input.documentId,
        version: updated.currentVersion,
        filename: nowFilename,
        mimeType: input.mimeType,
        size: blob.size,
        storageKey: blob.storageKey,
        editorState: input.editorState ?? null,
        note: input.note ?? "manual",
        createdById: input.userId,
      });

      await adapter.recordActivity(tx, input.userId, access.source, {
        type: "document_saved",
        newValue: nowFilename,
      });

      return { version: updated.currentVersion, size: blob.size };
    });

    const actorName = await getUserName(input.userId);
    broadcast(input.documentId, {
      type: "saved",
      version: result.version,
      actorId: input.userId,
      actorName: actorName ?? "成员",
      savedAt: new Date().toISOString(),
      note: input.note ?? "manual",
    });
    // 裁剪失败只影响磁盘占用，不影响本次保存
    void pruneDocumentVersions(input.documentId).catch(() => {});
    return result;
  } catch (e) {
    await deleteBlob(blob.storageKey);
    throw e;
  }
}

/**
 * 首次保存前固化原始版本。v1 与附件共用原 key 时不用复制；
 * 历史 bytea 附件需要物化成磁盘 blob。并发首次保存用唯一键兜底。
 */
async function ensureInitialVersion(
  exec: DbExec,
  doc: typeof documents.$inferSelect,
  access: DocumentAccess,
  adapter: ReturnType<typeof getDocumentSourceAdapter>,
  actorId: string,
): Promise<void> {
  if (doc.currentVersion !== 1) return;
  const [existing] = await exec
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(
      and(eq(documentVersions.documentId, doc.id), eq(documentVersions.version, 1)),
    );
  if (existing) return;

  const current = await adapter.read(access.source, maxBytesForFormat(doc.format as DocumentFormat));
  let storageKey = current.storageKey;
  if (!storageKey) {
    const saved = await saveBlobFromBuffer(current.data, maxBytesForFormat(doc.format as DocumentFormat));
    storageKey = saved.storageKey;
  }
  await exec
    .insert(documentVersions)
    .values({
      documentId: doc.id,
      version: 1,
      filename: current.filename,
      mimeType: current.mimeType,
      size: current.size,
      storageKey,
      note: "initial",
      createdById: doc.createdById ?? actorId,
    })
    .onConflictDoNothing();
}

export type SaveAsInput = {
  documentId: string;
  userId: string;
  newFilename: string;
  bytes: Buffer;
  mimeType: string | null;
  editorState?: unknown;
};

/** 另存为：在当前来源（任务）下创建新附件 + 新文档 + v1 */
export async function saveDocumentAs(
  input: SaveAsInput,
): Promise<{ documentId: string; filename: string }> {
  const access = await requireDocumentEdit(input.documentId, input.userId);
  const filename = normalizeFilename(input.newFilename);
  if (!isSameEditableFormat(access.document.filename, filename, access.document.format)) {
    throw new AppError("另存为只能使用与原文件相同的扩展名");
  }
  const maxBytes = maxBytesForFormat(access.document.format);
  if (input.bytes.length === 0) throw new AppError("不能保存空文档");
  if (input.bytes.length > maxBytes) throw new AppError("文档超过在线编辑大小上限");

  const blob = await saveBlobFromBuffer(input.bytes, maxBytes);
  const adapter = getDocumentSourceAdapter(access.document.sourceType);

  try {
    const result = await db.transaction(async (tx) => {
      const copy = await adapter.createCopy(tx, input.userId, access.source, {
        storageKey: blob.storageKey,
        size: blob.size,
        mimeType: input.mimeType,
        filename,
      });

      const [newDoc] = await tx
        .insert(documents)
        .values({
          sourceType: copy.sourceType,
          sourceId: copy.sourceId,
          taskId: copy.taskId,
          format: access.document.format,
          filename,
          mimeType: input.mimeType,
          currentVersion: 1,
          collaborationEnabled: false,
          createdById: input.userId,
        })
        .returning({ id: documents.id });

      await tx.insert(documentVersions).values({
        documentId: newDoc.id,
        version: 1,
        filename,
        mimeType: input.mimeType,
        size: blob.size,
        storageKey: blob.storageKey,
        editorState: input.editorState ?? null,
        note: "save_as",
        createdById: input.userId,
      });

      await adapter.recordActivity(tx, input.userId, access.source, {
        type: "document_saved_as",
        newValue: filename,
      });

      return { documentId: newDoc.id, filename };
    });
    return result;
  } catch (e) {
    await deleteBlob(blob.storageKey);
    throw e;
  }
}

/**
 * 恢复历史版本：把某个版本的内容（同一个 blob key）变成新的当前版本。
 *
 * 不复制字节、不让客户端重新上传：事务内直接引用旧版本的 storageKey，
 * 同时复制 editorState，保存后编辑器按最新版本重新载入。旧版本行保持不动，
 * 因此「恢复」本身也留下一条可回退的版本记录。
 */
export async function restoreDocumentVersion(input: {
  documentId: string;
  userId: string;
  sessionId: string;
  version: number;
}): Promise<{ version: number }> {
  const access = await requireDocumentEdit(input.documentId, input.userId);
  const adapter = getDocumentSourceAdapter(access.document.sourceType);

  const result = await db.transaction(async (tx) => {
    const [doc] = await tx
      .select()
      .from(documents)
      .where(eq(documents.id, input.documentId))
      .for("update");
    if (!doc) throw new AppError("文档不存在");

    if (!doc.collaborationEnabled) {
      await assertLockHeld(tx, input.documentId, input.userId, input.sessionId);
    }

    const [src] = await tx
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, input.documentId),
          eq(documentVersions.version, input.version),
        ),
      );
    if (!src) throw new AppError("版本不存在");

    // 确认源文件仍可读：避免把已丢失的 blob 恢复成当前附件
    await readBlob(src.storageKey, maxBytesForFormat(doc.format as DocumentFormat));

    const [updated] = await tx
      .update(documents)
      .set({
        currentVersion: sql`${documents.currentVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, input.documentId))
      .returning({ currentVersion: documents.currentVersion });
    if (!updated) throw new AppError("恢复失败，请重试");

    await adapter.replace(tx, access.source, {
      storageKey: src.storageKey,
      size: src.size,
      mimeType: src.mimeType,
      filename: access.document.filename,
    });

    await tx.insert(documentVersions).values({
      documentId: input.documentId,
      version: updated.currentVersion,
      filename: access.document.filename,
      mimeType: src.mimeType,
      size: src.size,
      storageKey: src.storageKey,
      editorState: src.editorState,
      note: "restore",
      createdById: input.userId,
    });

    await adapter.recordActivity(tx, input.userId, access.source, {
      type: "document_saved",
      newValue: `恢复 v${input.version}`,
    });

    return { version: updated.currentVersion };
  });

  const actorName = await getUserName(input.userId);
  broadcast(input.documentId, {
    type: "saved",
    version: result.version,
    actorId: input.userId,
    actorName: actorName ?? "成员",
    savedAt: new Date().toISOString(),
    note: "restore",
  });
  void pruneDocumentVersions(input.documentId).catch(() => {});
  return result;
}

function normalizeFilename(raw: string): string {
  const trimmed = raw.trim().replace(/[\\/]/g, "");
  if (!trimmed) throw new AppError("文件名不能为空");
  if (trimmed.length > 200) throw new AppError("文件名不能超过 200 个字符");
  return trimmed;
}

// ------------------------------------------------------------------ 权限/协作

export async function setCollaboration(
  documentId: string,
  userId: string,
  enabled: boolean,
): Promise<void> {
  const access = await requireDocumentManage(documentId, userId);
  const adapter = getDocumentSourceAdapter(access.document.sourceType);

  await db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ collaborationEnabled: documents.collaborationEnabled })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");
    if (!doc) throw new AppError("文档不存在");
    if (doc.collaborationEnabled === enabled) return;

    await tx
      .update(documents)
      .set({ collaborationEnabled: enabled, updatedAt: sql`now()` })
      .where(eq(documents.id, documentId));
    await deleteLocksForDocument(tx, documentId);
    await adapter.recordActivity(tx, userId, access.source, {
      type: "document_collaboration_changed",
      newValue: enabled ? "多人协作" : "单人编辑",
    });
  });

  broadcast(documentId, {
    type: "settings",
    collaborationEnabled: enabled,
    actorId: userId,
  });
  broadcast(documentId, { type: "lock", lock: null });
  broadcastPresence(documentId);
}

export async function grantEditor(
  documentId: string,
  actorId: string,
  targetUserId: string,
): Promise<void> {
  const access = await requireDocumentManage(documentId, actorId);
  await assertTeamMemberForDocument(access, targetUserId);
  if (targetUserId === access.source.ownerUserId || targetUserId === actorId) {
    // 上传者/操作者本身已有管理权，无需落额外授权
    return;
  }
  const adapter = getDocumentSourceAdapter(access.document.sourceType);
  const targetName = await getUserName(targetUserId);

  await db.transaction(async (tx) => {
    await tx
      .insert(documentEditors)
      .values({ documentId, userId: targetUserId, grantedById: actorId })
      .onConflictDoNothing();
    await adapter.recordActivity(tx, actorId, access.source, {
      type: "document_editor_granted",
      newValue: targetName ?? "成员",
    });
  });

  broadcast(documentId, { type: "permission", userId: targetUserId, canEdit: true });
}

export async function revokeEditor(
  documentId: string,
  actorId: string,
  targetUserId: string,
): Promise<void> {
  const access = await requireDocumentManage(documentId, actorId);
  const adapter = getDocumentSourceAdapter(access.document.sourceType);
  const targetName = await getUserName(targetUserId);

  await db.transaction(async (tx) => {
    await tx
      .delete(documentEditors)
      .where(
        and(
          eq(documentEditors.documentId, documentId),
          eq(documentEditors.userId, targetUserId),
        ),
      );
    await deleteLockForUser(tx, documentId, targetUserId);
    await adapter.recordActivity(tx, actorId, access.source, {
      type: "document_editor_revoked",
      newValue: targetName ?? "成员",
    });
  });

  broadcast(documentId, { type: "permission", userId: targetUserId, canEdit: false });
}

export async function listDocumentEditors(documentId: string): Promise<
  { userId: string; name: string | null }[]
> {
  return db
    .select({ userId: documentEditors.userId, name: users.name })
    .from(documentEditors)
    .leftJoin(users, eq(documentEditors.userId, users.id))
    .where(eq(documentEditors.documentId, documentId));
}

export async function listDocumentVersions(documentId: string, limit = 50) {
  return db
    .select({
      version: documentVersions.version,
      filename: documentVersions.filename,
      size: documentVersions.size,
      note: documentVersions.note,
      createdById: documentVersions.createdById,
      creatorName: users.name,
      createdAt: documentVersions.createdAt,
    })
    .from(documentVersions)
    .leftJoin(users, eq(documentVersions.createdById, users.id))
    .where(eq(documentVersions.documentId, documentId))
    .orderBy(desc(documentVersions.version))
    .limit(limit);
}

export async function getVersionEditorState(
  documentId: string,
  version: number,
): Promise<unknown | null> {
  const [row] = await db
    .select({ editorState: documentVersions.editorState })
    .from(documentVersions)
    .where(
      and(eq(documentVersions.documentId, documentId), eq(documentVersions.version, version)),
    );
  return row?.editorState ?? null;
}

/** 页面初始数据：访问、锁、最新编辑态、历史与授权（有管理权时） */
export async function getDocumentState(documentId: string, userId: string) {
  const access = await requireDocumentAccess(documentId, userId);
  const [lock, versions, editors, editorState] = await Promise.all([
    getLockView(documentId),
    listDocumentVersions(documentId),
    access.canManage ? listDocumentEditors(documentId) : Promise.resolve([]),
    getVersionEditorState(documentId, access.document.currentVersion),
  ]);
  return { access, lock, versions, editors, editorState };
}

/** 权限面板的候选成员：文档所属团队的全部成员 */
export async function listTeamMembersForDocument(
  access: DocumentAccess,
): Promise<{ userId: string; name: string | null; role: TeamRole }[]> {
  if (!access.source.teamId) return [];
  return db
    .select({ userId: teamMembers.userId, name: users.name, role: teamMembers.role })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, access.source.teamId))
    .orderBy(teamMembers.role, users.name);
}

export async function getUserName(userId: string): Promise<string | null> {
  const [row] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return row?.name ?? null;
}

export function roleOf(access: DocumentAccess): TeamRole | null {
  return (access.role as TeamRole | null) ?? null;
}

export { deleteBlobIfUnreferenced };
