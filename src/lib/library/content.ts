import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { libraryVersions } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { requireLibraryItemAccess } from "./access";
import type { LibraryItemAccess } from "./types";

export type LibraryFileRef = {
  access: LibraryItemAccess;
  version: number;
  filename: string;
  mimeType: string | null;
  size: number;
  storageKey: string;
};

/** 取当前版本或历史版本的元数据 + blob key（下载路由用它流式响应） */
export async function getLibraryFileRef(
  actorId: string,
  itemId: string,
  version?: number,
): Promise<LibraryFileRef> {
  const access = await requireLibraryItemAccess(actorId, itemId);
  const target = version ?? access.item.currentVersion;

  const [row] = await db
    .select({
      filename: libraryVersions.filename,
      mimeType: libraryVersions.mimeType,
      size: libraryVersions.size,
      storageKey: libraryVersions.storageKey,
    })
    .from(libraryVersions)
    .where(
      and(eq(libraryVersions.itemId, itemId), eq(libraryVersions.version, target)),
    );
  if (!row) throw new AppError("版本不存在");

  return {
    access,
    version: target,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    storageKey: row.storageKey,
  };
}
