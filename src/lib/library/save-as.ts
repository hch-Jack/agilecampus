import { db } from "@/db";
import { deleteBlob, saveBlobFromBuffer } from "@/lib/blob-store";
import { AppError, ForbiddenError } from "@/lib/errors";
import { requireDocumentEdit } from "@/lib/documents/access";
import { isSameEditableFormat } from "@/lib/documents/format";
import { maxBytesForFormat } from "@/lib/documents/service";
import { assertFolderInLibrary, getLibraryAccess } from "./access";
import { ensureLibrary, getDefaultFolderId } from "./folders";
import { putVersionByName } from "./versions";
import type { LibraryRef } from "./types";

function normalizeFilename(raw: string): string {
  const name = raw.trim().replace(/[\\/]/g, "");
  if (!name) throw new AppError("文件名不能为空");
  if (name.length > 200) throw new AppError("文件名不能超过 200 个字符");
  return name;
}

/**
 * 编辑器「另存为资源库文件」：把当前编辑内容写进目标库的指定文件夹。
 * 同名（同库同文件夹）会追加为版本；否则新建条目 + v1。
 */
export async function saveDocumentBytesToLibrary(input: {
  documentId: string;
  userId: string;
  filename: string;
  scope: "personal" | "team";
  teamId?: string;
  folderId?: string | null;
  bytes: Buffer;
  mimeType: string | null;
  editorState?: unknown;
}): Promise<{
  itemId: string;
  version: number;
  filename: string;
  folderId: string | null;
  scope: "personal" | "team";
  teamId?: string;
}> {
  const docAccess = await requireDocumentEdit(input.documentId, input.userId);
  const format = docAccess.document.format;
  const filename = normalizeFilename(input.filename);

  if (!isSameEditableFormat(docAccess.document.filename, filename, format)) {
    throw new AppError("另存为只能使用与原文件相同的扩展名");
  }
  const maxBytes = maxBytesForFormat(format);
  if (input.bytes.length === 0) throw new AppError("不能保存空文档");
  if (input.bytes.length > maxBytes) throw new AppError("文档超过在线编辑大小上限");

  const ref: LibraryRef =
    input.scope === "personal"
      ? { kind: "personal", userId: input.userId }
      : { kind: "team", teamId: input.teamId ?? "" };
  if (input.scope === "team" && !input.teamId) throw new AppError("请选择目标团队");

  const library = await ensureLibrary(ref);
  const access = await getLibraryAccess(input.userId, ref);
  if (!access?.canEdit) throw new ForbiddenError("你没有目标资源库的编辑权限");

  // undefined = 默认「手动上传」文件夹；null = 资源库根目录
  const folderId =
    input.folderId === undefined
      ? await getDefaultFolderId(library, "manual")
      : input.folderId;
  if (folderId) await assertFolderInLibrary(db, library.id, folderId);

  const blob = await saveBlobFromBuffer(input.bytes, maxBytes);
  try {
    const res = await db.transaction(async (tx) => {
      return putVersionByName(tx, {
        library,
        folderId,
        filename,
        mimeType: input.mimeType,
        storageKey: blob.storageKey,
        size: blob.size,
        editorState: input.editorState,
        note: "save_as",
        origin: "manual",
        createdById: input.userId,
        operationType: "document_saved_as",
        operationNote: `来自文档 ${input.documentId}`,
      });
    });
    return {
      ...res,
      filename,
      folderId,
      scope: input.scope,
      teamId: input.teamId,
    };
  } catch (e) {
    await deleteBlob(blob.storageKey);
    throw e;
  }
}
