import { db } from "@/db";
import { deleteBlob, saveBlobFromStream } from "@/lib/blob-store";
import { AppError, ForbiddenError } from "@/lib/errors";
import { MAX_FILE_SIZE } from "@/lib/file-limits";
import { assertFolderInLibrary, getLibraryAccess } from "./access";
import { ensureLibrary, getDefaultFolderId } from "./folders";
import { putVersionByName } from "./versions";
import type { LibraryRef } from "./types";

function normalizeFilename(raw: string): string {
  const name = raw.trim().replace(/[\\/]/g, "");
  if (!name) throw new AppError("缺少文件名");
  if (name.length > 200) throw new AppError("文件名不能超过 200 个字符");
  return name;
}

/** 手动上传到资源库：流式写盘 → 事务内按同名合并写版本 */
export async function uploadToLibrary(
  actorId: string,
  ref: LibraryRef,
  opts: {
    /** undefined = 默认「手动上传」；null = 资源库根目录 */
    folderId?: string | null;
    filename: string;
    mimeType: string | null;
    stream: ReadableStream<Uint8Array>;
  },
): Promise<{ itemId: string; version: number; created: boolean; folderId: string | null }> {
  const library = await ensureLibrary(ref);
  const access = await getLibraryAccess(actorId, ref);
  if (!access?.canEdit) throw new ForbiddenError("你没有该资源库的编辑权限");

  const filename = normalizeFilename(opts.filename);
  const folderId =
    opts.folderId === undefined
      ? await getDefaultFolderId(library, "manual")
      : opts.folderId;
  if (folderId) await assertFolderInLibrary(db, library.id, folderId);

  const blob = await saveBlobFromStream(opts.stream, MAX_FILE_SIZE);
  try {
    const res = await db.transaction(async (tx) => {
      return putVersionByName(tx, {
        library,
        folderId,
        filename,
        mimeType: opts.mimeType,
        storageKey: blob.storageKey,
        size: blob.size,
        note: "upload",
        origin: "manual",
        createdById: actorId,
        operationType: "item_uploaded",
      });
    });
    return { ...res, folderId };
  } catch (e) {
    await deleteBlob(blob.storageKey);
    throw e;
  }
}
