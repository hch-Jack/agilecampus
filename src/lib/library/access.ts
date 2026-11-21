import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { libraries, libraryFolders, libraryItems } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { getTeamMembership } from "@/lib/team";
import type { LibraryItemAccess, LibraryRef, LibraryRow } from "./types";
import type { DbExec } from "@/lib/documents/types";

export type LibraryAccess = {
  library: LibraryRow;
  role: "admin" | "teacher" | "student" | null;
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
};

/** 库级访问：个人库仅本人；团队库按成员角色（admin/student 可写，teacher 只读） */
export async function getLibraryAccess(
  actorId: string,
  ref: LibraryRef,
  exec: DbExec = db,
): Promise<LibraryAccess | null> {
  if (ref.kind === "personal") {
    if (ref.userId !== actorId) return null;
    const [library] = await exec
      .select()
      .from(libraries)
      .where(and(eq(libraries.kind, "personal"), eq(libraries.ownerId, ref.userId)));
    if (!library) return null;
    return { library, role: null, canView: true, canEdit: true, canManage: true };
  }

  const [library] = await exec
    .select()
    .from(libraries)
    .where(and(eq(libraries.kind, "team"), eq(libraries.teamId, ref.teamId)));
  if (!library) return null;
  const membership = await getTeamMembership(actorId, ref.teamId);
  if (!membership) return null;
  const canEdit = membership.role === "admin" || membership.role === "student";
  return {
    library,
    role: membership.role,
    canView: true,
    canEdit,
    canManage: canEdit,
  };
}

/** 条目级访问：不存在或无权读一律 null，避免泄露存在性 */
export async function getLibraryItemAccess(
  actorId: string,
  itemId: string,
): Promise<LibraryItemAccess | null> {
  const [row] = await db
    .select({ item: libraryItems, library: libraries })
    .from(libraryItems)
    .innerJoin(libraries, eq(libraryItems.libraryId, libraries.id))
    .where(eq(libraryItems.id, itemId));
  if (!row) return null;

  if (row.library.kind === "personal") {
    if (row.library.ownerId !== actorId) return null;
    return {
      item: row.item,
      library: row.library,
      role: null,
      canView: true,
      canEdit: true,
      canManage: true,
    };
  }

  if (!row.library.teamId) return null;
  const membership = await getTeamMembership(actorId, row.library.teamId);
  if (!membership) return null;
  const canEdit = membership.role === "admin" || membership.role === "student";
  return {
    item: row.item,
    library: row.library,
    role: membership.role,
    canView: true,
    canEdit,
    canManage: canEdit,
  };
}

export async function requireLibraryItemAccess(
  actorId: string,
  itemId: string,
): Promise<LibraryItemAccess> {
  const access = await getLibraryItemAccess(actorId, itemId);
  if (!access) throw new ForbiddenError("资源库文件不存在或你没有访问权限");
  return access;
}

export async function requireLibraryItemEdit(
  actorId: string,
  itemId: string,
): Promise<LibraryItemAccess> {
  const access = await requireLibraryItemAccess(actorId, itemId);
  if (!access.canEdit) throw new ForbiddenError("你没有该资源库文件的编辑权限");
  return access;
}

/** 文件夹必须属于目标库，防止跨库挪文件 */
export async function assertFolderInLibrary(
  exec: DbExec,
  libraryId: string,
  folderId: string,
): Promise<void> {
  const [row] = await exec
    .select({ id: libraryFolders.id })
    .from(libraryFolders)
    .where(and(eq(libraryFolders.id, folderId), eq(libraryFolders.libraryId, libraryId)));
  if (!row) throw new ForbiddenError("目标文件夹不存在");
}

export function libraryRefOf(library: LibraryRow): LibraryRef {
  if (library.kind === "personal") {
    if (!library.ownerId) throw new ForbiddenError("资源库归属异常");
    return { kind: "personal", userId: library.ownerId };
  }
  if (!library.teamId) throw new ForbiddenError("资源库归属异常");
  return { kind: "team", teamId: library.teamId };
}
