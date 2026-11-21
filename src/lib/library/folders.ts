import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  libraries,
  libraryFolders,
  libraryItems,
  librarySourceLinks,
  libraryVersions,
  users,
} from "@/db/schema";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { DbExec } from "@/lib/documents/types";
import { getLibraryAccess, assertFolderInLibrary } from "./access";
import { libraryFileType, libraryFileTypeLabel } from "./file-kind";
import { recordLibraryOperation } from "./operations";
import {
  DEFAULT_FOLDER_NAMES,
  type DefaultFolderKey,
  type LibraryBreadcrumb,
  type LibraryFolderView,
  type LibraryItemView,
  type LibraryKind,
  type LibraryOrigin,
  type LibraryQuery,
  type LibraryRef,
  type LibraryRow,
  type LibraryView,
} from "./types";

/** 幂等拿到团队/个人库；同时补齐默认文件夹 */
export async function ensureLibrary(
  ref: LibraryRef,
  exec: DbExec = db,
): Promise<LibraryRow> {
  if (ref.kind === "personal") {
    await exec
      .insert(libraries)
      .values({ kind: "personal", ownerId: ref.userId })
      .onConflictDoNothing();
    const [row] = await exec
      .select()
      .from(libraries)
      .where(and(eq(libraries.kind, "personal"), eq(libraries.ownerId, ref.userId)));
    if (!row) throw new AppError("无法创建个人资源库");
    await ensureDefaultFolders(row, exec);
    return row;
  }

  await exec
    .insert(libraries)
    .values({ kind: "team", teamId: ref.teamId })
    .onConflictDoNothing();
  const [row] = await exec
    .select()
    .from(libraries)
    .where(and(eq(libraries.kind, "team"), eq(libraries.teamId, ref.teamId)));
  if (!row) throw new AppError("无法创建团队资源库");
  await ensureDefaultFolders(row, exec);
  return row;
}

export async function ensureDefaultFolders(
  library: Pick<LibraryRow, "id" | "kind">,
  exec: DbExec = db,
): Promise<Partial<Record<DefaultFolderKey, string>>> {
  const defs = DEFAULT_FOLDER_NAMES[library.kind as LibraryKind];
  for (const name of Object.values(defs)) {
    if (!name) continue;
    await exec
      .insert(libraryFolders)
      .values({ libraryId: library.id, name, parentId: null, isDefault: true })
      .onConflictDoNothing();
  }
  const rows = await exec
    .select({ id: libraryFolders.id, name: libraryFolders.name, isDefault: libraryFolders.isDefault })
    .from(libraryFolders)
    .where(and(eq(libraryFolders.libraryId, library.id), eq(libraryFolders.isDefault, true)));

  const out: Partial<Record<DefaultFolderKey, string>> = {};
  for (const [key, name] of Object.entries(defs) as [DefaultFolderKey, string][]) {
    const hit = rows.find((r) => r.name === name);
    if (hit) out[key] = hit.id;
  }
  return out;
}

export async function getDefaultFolderId(
  library: Pick<LibraryRow, "id" | "kind">,
  key: DefaultFolderKey,
): Promise<string> {
  const map = await ensureDefaultFolders(library);
  const id = map[key];
  if (!id) throw new AppError("资源库默认文件夹缺失");
  return id;
}

async function getFolderInLibrary(
  libraryId: string,
  folderId: string,
): Promise<{ id: string; name: string; parentId: string | null; isDefault: boolean } | null> {
  const [row] = await db
    .select({
      id: libraryFolders.id,
      name: libraryFolders.name,
      parentId: libraryFolders.parentId,
      isDefault: libraryFolders.isDefault,
    })
    .from(libraryFolders)
    .where(and(eq(libraryFolders.id, folderId), eq(libraryFolders.libraryId, libraryId)));
  return row ?? null;
}

/** 面包屑：根 -> 当前文件夹 */
export async function folderBreadcrumbs(
  libraryId: string,
  folderId: string | null,
): Promise<LibraryBreadcrumb[]> {
  if (!folderId) return [];
  const out: LibraryBreadcrumb[] = [];
  let cursor: string | null = folderId;
  for (let depth = 0; cursor && depth < 50; depth++) {
    const row = await getFolderInLibrary(libraryId, cursor);
    if (!row) break;
    out.unshift({ id: row.id, name: row.name });
    cursor = row.parentId;
  }
  return out;
}

export async function listLibraryContents(
  actorId: string,
  ref: LibraryRef,
  folderId?: string | null,
  query: LibraryQuery = {},
): Promise<LibraryView> {
  const library = await ensureLibrary(ref);
  const access = await getLibraryAccess(actorId, ref);
  if (!access) throw new ForbiddenError("你没有该资源库的访问权限");

  const q = (query.q ?? "").trim();
  const type = query.type ?? "all";
  const sort = query.sort ?? "modified";
  const dir = query.dir ?? "desc";
  const searching = q.length > 0 || type !== "all";
  const lowerQ = q.toLowerCase();

  const allFolders = await db
    .select()
    .from(libraryFolders)
    .where(eq(libraryFolders.libraryId, library.id))
    .orderBy(asc(libraryFolders.name));
  const folderById = new Map(allFolders.map((f) => [f.id, f]));
  const currentFolder = folderId ? (folderById.get(folderId) ?? null) : null;
  const currentId = currentFolder?.id ?? null;

  const pathOf = (id: string | null): string => {
    if (!id) return "";
    const names: string[] = [];
    let cursor: string | null = id;
    for (let depth = 0; cursor && depth < 50; depth++) {
      const folder = folderById.get(cursor);
      if (!folder) break;
      names.unshift(folder.name);
      cursor = folder.parentId;
    }
    return names.join(" / ");
  };

  // 搜索范围 = 当前文件夹及其子文件夹；根目录 = 整库
  const descendantIds: string[] = [];
  if (searching) {
    const childrenOf = new Map<string | null, string[]>();
    for (const folder of allFolders) {
      const list = childrenOf.get(folder.parentId);
      if (list) list.push(folder.id);
      else childrenOf.set(folder.parentId, [folder.id]);
    }
    const stack = currentId
      ? [...(childrenOf.get(currentId) ?? [])]
      : [...(childrenOf.get(null) ?? [])];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      descendantIds.push(id);
      stack.push(...(childrenOf.get(id) ?? []));
    }
  }

  const itemScopeIds = searching
    ? currentId
      ? [currentId, ...descendantIds]
      : descendantIds
    : currentId
      ? [currentId]
      : [];

  const countRows = await db
    .select({
      folderId: libraryItems.folderId,
      count: sql<number>`count(*)::int`,
    })
    .from(libraryItems)
    .where(eq(libraryItems.libraryId, library.id))
    .groupBy(libraryItems.folderId);
  const countMap = new Map(countRows.map((c) => [c.folderId, Number(c.count)]));

  const folderRows = searching
    ? allFolders.filter(
        (folder) =>
          type === "all" &&
          descendantIds.includes(folder.id) &&
          (!lowerQ || folder.name.toLowerCase().includes(lowerQ)),
      )
    : allFolders.filter((folder) => (folder.parentId ?? null) === currentId);

  const itemRows =
    itemScopeIds.length === 0
      ? []
      : await db
          .select()
          .from(libraryItems)
          .where(
            and(
              eq(libraryItems.libraryId, library.id),
              inArray(libraryItems.folderId, itemScopeIds),
            ),
          );

  const filteredItems = itemRows.filter((item) => {
    if (lowerQ && !item.filename.toLowerCase().includes(lowerQ)) return false;
    if (type !== "all" && libraryFileType(item.filename, item.mimeType) !== type) return false;
    return true;
  });

  const itemIds = filteredItems.map((item) => item.id);
  const currentRows =
    itemIds.length === 0
      ? []
      : await db
          .select({
            itemId: libraryItems.id,
            creatorName: users.name,
            createdAt: libraryVersions.createdAt,
          })
          .from(libraryItems)
          .innerJoin(
            libraryVersions,
            and(
              eq(libraryVersions.itemId, libraryItems.id),
              eq(libraryVersions.version, libraryItems.currentVersion),
            ),
          )
          .leftJoin(users, eq(libraryVersions.createdById, users.id))
          .where(inArray(libraryItems.id, itemIds));
  const totalCounts =
    itemIds.length === 0
      ? []
      : await db
          .select({
            itemId: libraryVersions.itemId,
            count: sql<number>`count(*)::int`,
          })
          .from(libraryVersions)
          .where(inArray(libraryVersions.itemId, itemIds))
          .groupBy(libraryVersions.itemId);
  const countByItem = new Map(totalCounts.map((c) => [c.itemId, Number(c.count)]));
  const statsMap = new Map(
    currentRows.map((row) => [
      row.itemId,
      { ...row, versionCount: countByItem.get(row.itemId) ?? 1 },
    ]),
  );

  const liveLinks =
    itemIds.length === 0
      ? []
      : await db
          .select({ itemId: librarySourceLinks.itemId })
          .from(librarySourceLinks)
          .where(
            and(
              inArray(librarySourceLinks.itemId, itemIds),
              eq(librarySourceLinks.mode, "live"),
            ),
          );
  const liveSet = new Set(liveLinks.map((l) => l.itemId));

  const folders: LibraryFolderView[] = folderRows.map((folder) => ({
    id: folder.id,
    name: folder.name,
    isDefault: folder.isDefault,
    parentId: folder.parentId,
    itemCount: countMap.get(folder.id) ?? 0,
    updatedAt: folder.updatedAt,
    path: searching ? pathOf(folder.id) : undefined,
  }));

  const items: LibraryItemView[] = filteredItems.map((item) => {
    const stat = statsMap.get(item.id);
    return {
      id: item.id,
      folderId: item.folderId,
      filename: item.filename,
      mimeType: item.mimeType,
      size: item.size,
      currentVersion: item.currentVersion,
      origin: item.origin as LibraryOrigin,
      updatedAt: item.updatedAt,
      currentActorName: stat?.creatorName ?? null,
      currentCreatedAt: stat?.createdAt ?? null,
      versionCount: Number(stat?.versionCount ?? 1),
      live: liveSet.has(item.id),
      folderPath: pathOf(item.folderId),
    };
  });

  const factor = dir === "asc" ? 1 : -1;
  const text = (a: string, b: string) => a.localeCompare(b, "zh-CN");
  folders.sort((a, b) => {
    let cmp = 0;
    if (sort === "modified") cmp = a.updatedAt.getTime() - b.updatedAt.getTime();
    else if (sort === "size") cmp = a.itemCount - b.itemCount;
    else cmp = text(a.name, b.name);
    return (cmp || text(a.name, b.name)) * factor;
  });
  items.sort((a, b) => {
    let cmp = 0;
    if (sort === "modified") cmp = a.updatedAt.getTime() - b.updatedAt.getTime();
    else if (sort === "size") cmp = a.size - b.size;
    else if (sort === "type") {
      cmp = text(libraryFileTypeLabel(a.filename, a.mimeType), libraryFileTypeLabel(b.filename, b.mimeType));
    } else cmp = text(a.filename, b.filename);
    return (cmp || text(a.filename, b.filename)) * factor;
  });

  return {
    library,
    folder: currentFolder,
    breadcrumbs: await folderBreadcrumbs(library.id, currentFolder?.id ?? null),
    folders,
    items,
    canEdit: access.canEdit,
    query: { q, type, sort, dir },
    searching,
  };
}

// ------------------------------------------------------------------ 文件夹写操作

const MAX_FOLDER_NAME = 60;

function normalizeFolderName(raw: string): string {
  const name = raw.trim().replace(/[\\/]/g, "");
  if (!name) throw new AppError("文件夹名称不能为空");
  if (name.length > MAX_FOLDER_NAME) throw new AppError(`文件夹名称不能超过 ${MAX_FOLDER_NAME} 个字符`);
  return name;
}

async function assertSiblingNameFree(
  libraryId: string,
  parentId: string | null,
  name: string,
  exceptId?: string,
): Promise<void> {
  const [hit] = await db
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(
      and(
        eq(libraryFolders.libraryId, libraryId),
        parentId ? eq(libraryFolders.parentId, parentId) : isNull(libraryFolders.parentId),
        sql`lower(${libraryFolders.name}) = ${name.toLowerCase()}`,
        exceptId ? sql`${libraryFolders.id} <> ${exceptId}` : undefined,
      ),
    );
  if (hit) throw new AppError("同一位置已有同名文件夹");
}

export async function createLibraryFolder(
  actorId: string,
  ref: LibraryRef,
  parentId: string | null,
  rawName: string,
): Promise<{ id: string }> {
  const library = await ensureLibrary(ref);
  const access = await getLibraryAccess(actorId, ref);
  if (!access?.canEdit) throw new ForbiddenError("你没有该资源库的编辑权限");
  if (parentId) await assertFolderInLibrary(db, library.id, parentId);
  const name = normalizeFolderName(rawName);
  await assertSiblingNameFree(library.id, parentId, name);

  const [row] = await db
    .insert(libraryFolders)
    .values({ libraryId: library.id, parentId, name })
    .returning({ id: libraryFolders.id });

  await recordLibraryOperation(db, {
    libraryId: library.id,
    folderId: row.id,
    actorId,
    type: "folder_created",
    newValue: name,
  });
  return { id: row.id };
}

export async function renameLibraryFolder(
  actorId: string,
  folderId: string,
  rawName: string,
): Promise<void> {
  const folder = await getFolderInLibraryById(folderId);
  if (!folder) throw new AppError("文件夹不存在");
  const ref: LibraryRef = folder.library.kind === "personal"
    ? { kind: "personal", userId: folder.library.ownerId! }
    : { kind: "team", teamId: folder.library.teamId! };
  const access = await getLibraryAccess(actorId, ref);
  if (!access?.canEdit) throw new ForbiddenError("你没有该资源库的编辑权限");
  if (folder.isDefault) throw new AppError("默认文件夹不能改名");

  const name = normalizeFolderName(rawName);
  await assertSiblingNameFree(folder.libraryId, folder.parentId, name, folder.id);
  await db
    .update(libraryFolders)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(libraryFolders.id, folderId));
  await recordLibraryOperation(db, {
    libraryId: folder.libraryId,
    folderId,
    actorId,
    type: "folder_renamed",
    oldValue: folder.name,
    newValue: name,
  });
}

export async function deleteLibraryFolder(actorId: string, folderId: string): Promise<void> {
  const folder = await getFolderInLibraryById(folderId);
  if (!folder) throw new AppError("文件夹不存在");
  const ref: LibraryRef = folder.library.kind === "personal"
    ? { kind: "personal", userId: folder.library.ownerId! }
    : { kind: "team", teamId: folder.library.teamId! };
  const access = await getLibraryAccess(actorId, ref);
  if (!access?.canEdit) throw new ForbiddenError("你没有该资源库的编辑权限");
  if (folder.isDefault) throw new AppError("默认文件夹不能删除");

  const [child] = await db
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(eq(libraryFolders.parentId, folderId))
    .limit(1);
  if (child) throw new AppError("文件夹里还有子文件夹，请先清空");
  const [item] = await db
    .select({ id: libraryItems.id })
    .from(libraryItems)
    .where(eq(libraryItems.folderId, folderId))
    .limit(1);
  if (item) throw new AppError("文件夹里还有文件，请先移动或删除");

  await recordLibraryOperation(db, {
    libraryId: folder.libraryId,
    folderId: null,
    actorId,
    type: "folder_deleted",
    oldValue: folder.name,
  });
  await db.delete(libraryFolders).where(eq(libraryFolders.id, folderId));
}

async function getFolderInLibraryById(folderId: string): Promise<{
  id: string;
  libraryId: string;
  name: string;
  parentId: string | null;
  isDefault: boolean;
  library: LibraryRow;
} | null> {
  const [row] = await db
    .select({ folder: libraryFolders, library: libraries })
    .from(libraryFolders)
    .innerJoin(libraries, eq(libraryFolders.libraryId, libraries.id))
    .where(eq(libraryFolders.id, folderId));
  if (!row) return null;
  return {
    id: row.folder.id,
    libraryId: row.folder.libraryId,
    name: row.folder.name,
    parentId: row.folder.parentId,
    isDefault: row.folder.isDefault,
    library: row.library,
  };
}
