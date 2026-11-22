"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AppError, ForbiddenError } from "@/lib/errors";
import { listMyTeams } from "@/lib/team";
import { getLibraryAccess, getLibraryItemAccess } from "@/lib/library/access";
import { ensureLibrary } from "@/lib/library/folders";
import { getDefaultFolderId } from "@/lib/library/folders";
import {
  createLibraryFolder,
  deleteLibraryFolder,
  renameLibraryFolder,
} from "@/lib/library/folders";
import { syncPersonalLibrary, syncTeamLibrary } from "@/lib/library/sync";
import { restoreLibraryVersion } from "@/lib/library/restore";
import {
  deleteLibraryItem,
  deleteLibraryVersion,
  moveLibraryItem,
  renameLibraryItem,
} from "@/lib/library/versions";
import {
  listGroupFiles,
  syncGroupFileToLibrary,
  type GroupFileView,
} from "@/lib/group-files";
import type { LibraryRef, LibraryRow } from "@/lib/library/types";
import { db } from "@/db";
import { libraryFolders } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export type ActionResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

export type FolderOption = {
  id: string;
  name: string;
  isDefault: boolean;
  depth: number;
};

export type LibraryDestination = {
  key: string;
  label: string;
  scope: "personal" | "team";
  teamId?: string;
  folders: FolderOption[];
};

const scopeSchema = z.object({
  scope: z.enum(["personal", "team"]),
  teamId: z.uuid().optional(),
});

type ScopeInput = z.infer<typeof scopeSchema>;

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError("请先登录");
  return session.user.id;
}

function refOf(userId: string, input: ScopeInput): LibraryRef {
  if (input.scope === "personal") return { kind: "personal", userId };
  if (!input.teamId) throw new AppError("请选择团队");
  return { kind: "team", teamId: input.teamId };
}

function fail(e: unknown): ActionResult<never> {
  if (e instanceof ForbiddenError || e instanceof AppError) {
    return { ok: false, error: e.message };
  }
  throw e;
}

async function foldersOf(library: LibraryRow): Promise<FolderOption[]> {
  const rows = await db
    .select()
    .from(libraryFolders)
    .where(eq(libraryFolders.libraryId, library.id))
    .orderBy(asc(libraryFolders.isDefault), asc(libraryFolders.name));

  const byParent = new Map<string | null, typeof rows>();
  for (const row of rows) {
    const list = byParent.get(row.parentId);
    if (list) list.push(row);
    else byParent.set(row.parentId, [row]);
  }
  const out: FolderOption[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const row of byParent.get(parentId) ?? []) {
      out.push({ id: row.id, name: row.name, isDefault: row.isDefault, depth });
      walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 群文件同步 / 编辑器另存为的目标列表：个人库 + 我有写权限的团队库 */
export async function listLibraryDestinationsAction(): Promise<ActionResult<LibraryDestination[]>> {
  try {
    const userId = await requireUserId();
    const dests: LibraryDestination[] = [];

    const personal = await ensureLibrary({ kind: "personal", userId });
    dests.push({
      key: "personal",
      label: "个人资源库",
      scope: "personal",
      folders: await foldersOf(personal),
    });

    for (const team of await listMyTeams(userId)) {
      if (team.role !== "admin" && team.role !== "student") continue;
      const library = await ensureLibrary({ kind: "team", teamId: team.id });
      dests.push({
        key: `team:${team.id}`,
        label: `${team.name} · 团队资源库`,
        scope: "team",
        teamId: team.id,
        folders: await foldersOf(library),
      });
    }
    return { ok: true, data: dests };
  } catch (e) {
    return fail(e);
  }
}

/** 某个库的文件夹列表（弹窗切换目标时用） */
export async function listLibraryFoldersAction(
  scope: "personal" | "team",
  teamId?: string,
): Promise<ActionResult<FolderOption[]>> {
  try {
    const userId = await requireUserId();
    const ref = refOf(userId, scopeSchema.parse({ scope, teamId }));
    const access = await getLibraryAccess(userId, ref);
    if (!access) return { ok: false, error: "你没有该资源库的访问权限" };
    return { ok: true, data: await foldersOf(access.library) };
  } catch (e) {
    return fail(e);
  }
}

export async function syncLibraryNowAction(
  scope: "personal" | "team",
  teamId?: string,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    const ref = refOf(userId, scopeSchema.parse({ scope, teamId }));
    if (ref.kind === "personal") await syncPersonalLibrary(userId, { force: true });
    else await syncTeamLibrary(userId, ref.teamId, { force: true });
    revalidatePath("/library");
    if (ref.kind === "team") revalidatePath(`/teams/${ref.teamId}/library`);
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

export async function createFolderAction(input: {
  scope: "personal" | "team";
  teamId?: string;
  parentId?: string | null;
  name: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const userId = await requireUserId();
    const parsed = scopeSchema.parse({ scope: input.scope, teamId: input.teamId });
    const ref = refOf(userId, parsed);
    const res = await createLibraryFolder(userId, ref, input.parentId ?? null, input.name);
    revalidateLibrary(ref);
    return { ok: true, data: res };
  } catch (e) {
    return fail(e);
  }
}

export async function renameFolderAction(
  folderId: string,
  name: string,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    await renameLibraryFolder(userId, folderId, name);
    revalidateLibraryByFolder();
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteFolderAction(
  folderId: string,
  mode: "delete-all" | "keep-files" = "keep-files",
): Promise<ActionResult<{ deletedItems: number; movedItems: number; movedFolders: number }>> {
  try {
    const userId = await requireUserId();
    const data = await deleteLibraryFolder(userId, folderId, mode);
    revalidateLibraryByFolder();
    return { ok: true, data };
  } catch (e) {
    return fail(e);
  }
}

export async function renameItemAction(
  itemId: string,
  name: string,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    await renameLibraryItem(userId, itemId, name);
    await revalidateItem(userId, itemId);
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

export async function moveItemAction(
  itemId: string,
  /** null = 资源库根目录 */
  folderId: string | null,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    await moveLibraryItem(userId, itemId, folderId);
    await revalidateItem(userId, itemId);
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteItemAction(
  itemId: string,
  opts: { deleteSources?: boolean } = {},
): Promise<ActionResult<{ deletedSources: string[]; skippedSources: string[] }>> {
  try {
    const userId = await requireUserId();
    const access = await getLibraryItemAccess(userId, itemId);
    const result = await deleteLibraryItem(userId, itemId, opts);
    if (access) revalidateLibraryPath(access.library);
    return { ok: true, data: result };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteVersionAction(
  itemId: string,
  version: number,
): Promise<ActionResult> {
  try {
    const userId = await requireUserId();
    await deleteLibraryVersion(userId, itemId, version);
    await revalidateItem(userId, itemId);
    return { ok: true, data: null };
  } catch (e) {
    return fail(e);
  }
}

export async function restoreVersionAction(
  itemId: string,
  version: number,
): Promise<ActionResult<{ version: number }>> {
  try {
    const userId = await requireUserId();
    const result = await restoreLibraryVersion({ itemId, userId, version });
    await revalidateItem(userId, itemId);
    return { ok: true, data: result };
  } catch (e) {
    return fail(e);
  }
}

export async function listGroupFilesAction(
  groupId: string,
): Promise<ActionResult<GroupFileView[]>> {
  try {
    const userId = await requireUserId();
    return { ok: true, data: await listGroupFiles(userId, groupId) };
  } catch (e) {
    return fail(e);
  }
}

export async function syncGroupFileAction(input: {
  groupId: string;
  attachmentId: string;
  scope: "personal" | "team";
  teamId?: string;
  folderId?: string | null;
  mode: "live" | "snapshot";
}): Promise<ActionResult<{ itemId: string; version: number; created: boolean }>> {
  try {
    const userId = await requireUserId();
    const parsed = scopeSchema.parse({ scope: input.scope, teamId: input.teamId });
    const target = refOf(userId, parsed);
    const result = await syncGroupFileToLibrary({
      actorId: userId,
      groupId: input.groupId,
      attachmentId: input.attachmentId,
      target,
      folderId: input.folderId ?? null,
      mode: input.mode,
    });
    revalidateLibrary(target);
    return { ok: true, data: result };
  } catch (e) {
    return fail(e);
  }
}

/** 编辑器另存为弹窗需要默认选中的「手动上传」文件夹 */
export async function defaultManualFolderAction(
  scope: "personal" | "team",
  teamId?: string,
): Promise<ActionResult<string>> {
  try {
    const userId = await requireUserId();
    const ref = refOf(userId, scopeSchema.parse({ scope, teamId }));
    const library = await ensureLibrary(ref);
    return { ok: true, data: await getDefaultFolderId(library, "manual") };
  } catch (e) {
    return fail(e);
  }
}

// ------------------------------------------------------------------ 刷新辅助

function revalidateLibrary(ref: LibraryRef): void {
  revalidatePath("/library");
  if (ref.kind === "team") revalidatePath(`/teams/${ref.teamId}/library`);
}

function revalidateLibraryPath(library: LibraryRow): void {
  revalidatePath("/library");
  if (library.kind === "team" && library.teamId) {
    revalidatePath(`/teams/${library.teamId}/library`);
  }
}

function revalidateLibraryByFolder(): void {
  revalidatePath("/library");
  revalidatePath("/teams", "layout");
}

async function revalidateItem(userId: string, itemId: string): Promise<void> {
  const access = await getLibraryItemAccess(userId, itemId);
  if (access) revalidateLibraryPath(access.library);
}
