import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentFiles, libraries, libraryFolders, teams } from "@/db/schema";
import { AppError, ForbiddenError } from "@/lib/errors";
import { uploadAttachment } from "@/lib/attachment";
import { deleteBlob, readStoredContent, saveBlobFromBuffer } from "@/lib/blob-store";
import { MAX_FILE_SIZE } from "@/lib/file-limits";
import { ensureDocument } from "@/lib/documents/service";
import {
  assertFolderInLibrary,
  getLibraryAccess,
  libraryRefOf,
  requireLibraryItemAccess,
} from "@/lib/library/access";
import { getLibraryFileRef } from "@/lib/library/content";
import {
  ensureLibrary,
  folderBreadcrumbs,
  getDefaultFolderId,
  listLibraryContents,
} from "@/lib/library/folders";
import { getDashboardLibrarySummary } from "@/lib/library/summary";
import {
  findItemByName,
  listItemVersions,
  putVersionByName,
} from "@/lib/library/versions";
import { syncPersonalLibrary, syncTeamLibrary } from "@/lib/library/sync";
import { NOTE_LABELS, ORIGIN_LABELS } from "@/lib/library/types";
import type {
  LibraryQuery,
  LibraryRef,
  LibraryRow,
  LibrarySortDir,
  LibrarySortField,
} from "@/lib/library/types";
import {
  libraryFileType,
  libraryFileTypeLabel,
  type LibraryFileType,
} from "@/lib/library/file-kind";
import { getTeamForMember, listMyTeams } from "@/lib/team";
import { extractFileText, type ExtractedFileText } from "./file-text";
import { getAgentFileForDownload } from "./files";

/**
 * 资源库 × AI 助手的服务端能力层。
 *
 * 读能力（浏览/搜索/读正文/预览/版本）直接执行；写能力一律由 tools.ts 包成草案，
 * 用户确认后经 commit.ts 走到这里。权限不在这里发明：每个入口都复用
 * `lib/library/access.ts` 的口径（个人库仅本人；团队库 admin/student 可写、teacher 只读），
 * 与网页、REST 入口完全一致。
 */

/** 模型给的是「个人 / 团队」二选一；团队必须带 teamId */
export type LibraryScopeInput = {
  scope: "personal" | "team";
  teamId?: string | null;
};

export type LibraryScopeInfo = {
  ref: LibraryRef;
  library: LibraryRow;
  label: string;
  canEdit: boolean;
};

/** 与 `read_file` 同口径：docx/xlsx 解析需要整份文件，超过 32MB 直接给说明 */
const READ_TEXT_MAX_BYTES = 32 * 1024 * 1024;

export function libraryRefFromScope(
  actorId: string,
  input: LibraryScopeInput,
): LibraryRef {
  if (input.scope === "personal") return { kind: "personal", userId: actorId };
  if (!input.teamId) throw new AppError("团队资源库需要 teamId（取自快照「我的团队」）");
  return { kind: "team", teamId: input.teamId };
}

async function teamNameOf(teamId: string): Promise<string> {
  const [row] = await db
    .select({ name: teams.name })
    .from(teams)
    .where(eq(teams.id, teamId));
  return row?.name ?? "团队";
}

/** 解析目标库并校验访问权；写操作再要求 canEdit */
export async function resolveLibraryScope(
  actorId: string,
  input: LibraryScopeInput,
  opts: { needEdit?: boolean } = {},
): Promise<LibraryScopeInfo> {
  const ref = libraryRefFromScope(actorId, input);
  // 团队先验成员身份，免得为一个不属于他的团队建出空库
  const teamName =
    ref.kind === "team" ? (await getTeamForMember(actorId, ref.teamId)).name : null;
  const library = await ensureLibrary(ref);
  const access = await getLibraryAccess(actorId, ref);
  if (!access) throw new ForbiddenError("资源库不存在或你没有访问权限");
  if (opts.needEdit && !access.canEdit)
    throw new ForbiddenError("你没有该资源库的编辑权限");

  const label =
    ref.kind === "personal" ? "个人资源库" : `${teamName} · 团队资源库`;
  return { ref, library, label, canEdit: access.canEdit };
}

/**
 * 浏览资源库前做一次节流同步：与打开资源库页面同一口径，15 秒内不会重复跑。
 * 同步失败不阻断浏览 —— 页面也是先展示上次已汇总的内容。
 */
async function syncBeforeBrowse(actorId: string, ref: LibraryRef): Promise<void> {
  if (ref.kind === "personal") {
    await syncPersonalLibrary(actorId).catch(() => {});
  } else {
    await syncTeamLibrary(actorId, ref.teamId).catch(() => {});
  }
}

export type LibraryFolderBrief = {
  folderId: string;
  name: string;
  parentId: string | null;
  isDefault: boolean;
  path: string;
  itemCount: number;
  updatedAt: string;
};

export type LibraryItemBrief = {
  itemId: string;
  filename: string;
  folderId: string | null;
  folderPath: string;
  mimeType: string | null;
  size: number;
  type: string;
  typeLabel: string;
  currentVersion: number;
  versionCount: number;
  origin: string;
  originLabel: string;
  updatedAt: string;
  live: boolean;
};

export function itemBrief(
  item: {
    id: string;
    filename: string;
    folderId: string | null;
    folderPath?: string;
    mimeType: string | null;
    size: number;
    currentVersion: number;
    versionCount: number;
    origin: string;
    updatedAt: Date;
    live: boolean;
  },
): LibraryItemBrief {
  return {
    itemId: item.id,
    filename: item.filename,
    folderId: item.folderId,
    folderPath: item.folderPath ?? "",
    mimeType: item.mimeType,
    size: item.size,
    type: libraryFileType(item.filename, item.mimeType),
    typeLabel: libraryFileTypeLabel(item.filename, item.mimeType),
    currentVersion: item.currentVersion,
    versionCount: item.versionCount,
    origin: item.origin,
    originLabel: ORIGIN_LABELS[item.origin as keyof typeof ORIGIN_LABELS] ?? item.origin,
    updatedAt: item.updatedAt.toISOString(),
    live: item.live,
  };
}

/** 列表工具一次最多回多少条（其余让模型缩小范围或分页） */
const BROWSE_ITEM_LIMIT = 50;
const SEARCH_ITEM_LIMIT = 50;
const SEARCH_FOLDER_LIMIT = 20;

export async function browseLibrary(
  actorId: string,
  input: LibraryScopeInput & {
    folderId?: string | null;
    q?: string;
    type?: LibraryFileType;
    sort?: LibrarySortField;
    dir?: LibrarySortDir;
  },
) {
  const scope = await resolveLibraryScope(actorId, input);
  await syncBeforeBrowse(actorId, scope.ref);

  const query: LibraryQuery = {
    q: input.q?.trim() ?? "",
    type: input.type ?? "all",
    sort: input.sort ?? "modified",
    dir: input.dir ?? "desc",
  };
  const view = await listLibraryContents(
    actorId,
    scope.ref,
    input.folderId ?? null,
    query,
  );
  // 传了别的库的 folderId 时 listLibraryContents 会静默回落到根目录；
  // 助手场景下必须报错，否则模型以为自己在 Browse 目标文件夹
  if (input.folderId && !view.folder)
    throw new AppError("文件夹不存在或不属于该资源库");

  // 普通浏览时 listLibraryContents 只给当前层的文件夹、不带 path；
  // 这里用「当前目录路径 + 子文件夹名」补出来，拟稿卡片就能显示完整位置。
  const currentPath = view.breadcrumbs.map((b) => b.name).join(" / ");
  const folders: LibraryFolderBrief[] = view.folders.map((f) => ({
    folderId: f.id,
    name: f.name,
    parentId: f.parentId,
    isDefault: f.isDefault,
    path: f.path ?? (currentPath ? `${currentPath} / ${f.name}` : f.name),
    itemCount: f.itemCount,
    updatedAt: f.updatedAt.toISOString(),
  }));
  const items = view.items
    .slice(0, BROWSE_ITEM_LIMIT)
    .map((item) => itemBrief(item));

  return {
    library: {
      scope: scope.ref.kind,
      teamId: scope.ref.kind === "team" ? scope.ref.teamId : null,
      label: scope.label,
      canEdit: scope.canEdit,
    },
    folder: view.folder
      ? {
          folderId: view.folder.id,
          name: view.folder.name,
          path: view.breadcrumbs.map((b) => b.name).join(" / "),
        }
      : null,
    breadcrumbs: view.breadcrumbs,
    searching: view.searching,
    folders,
    items,
    itemTotal: view.items.length,
    itemTruncated: view.items.length > BROWSE_ITEM_LIMIT,
    hint:
      view.items.length === 0 && folders.length === 0
        ? "当前目录为空；用 save_file_to_library 把助手文件存进来，或用 create_library_folder 新建文件夹。"
        : "itemId 用于 read_library_file / open_library_file / edit_library_file 及各类写操作草案。",
  };
}

type AccessibleLibrary = {
  ref: LibraryRef;
  label: string;
  teamId: string | null;
};

async function listAccessibleLibraries(
  actorId: string,
  scope: "all" | "personal" | "team",
  teamId?: string | null,
): Promise<AccessibleLibrary[]> {
  if (scope === "personal") {
    await ensureLibrary({ kind: "personal", userId: actorId });
    return [
      { ref: { kind: "personal", userId: actorId }, label: "个人资源库", teamId: null },
    ];
  }

  const myTeams = await listMyTeams(actorId);
  // teamId 省略 = 搜索/浏览我所在的全部团队库（scope=all 内部会这样调用）；
  // 只有明确指定了 teamId 却不在团队里才是错误。
  const targetTeams = teamId ? myTeams.filter((t) => t.id === teamId) : myTeams;
  if (scope === "team" && teamId && targetTeams.length === 0)
    throw new AppError("找不到该团队或你不在团队里");

  const out: AccessibleLibrary[] = [];
  for (const team of targetTeams) {
    const ref: LibraryRef = { kind: "team", teamId: team.id };
    // 成员身份已由 listMyTeams 保证；先幂等建库，别让「刚建团队还没打开过资源库」搜不到
    await ensureLibrary(ref);
    const access = await getLibraryAccess(actorId, ref);
    if (!access) continue;
    out.push({
      ref,
      label: `${team.name} · 团队资源库`,
      teamId: team.id,
    });
  }
  return out;
}

/**
 * 跨库搜文件名（资源库页面也按文件名搜索）。搜索范围是整个库，不是当前文件夹：
 * 根目录查询时 `listLibraryContents` 已把全部子孙文件夹纳入。
 */
export async function searchLibrary(
  actorId: string,
  input: {
    query: string;
    scope?: "all" | "personal" | "team";
    teamId?: string | null;
    limit?: number;
  },
) {
  const query = input.query.trim();
  if (!query) throw new AppError("请输入要搜索的关键词");
  const scope = input.scope ?? "all";
  if (scope === "team" && !input.teamId)
    throw new AppError("限定团队资源库搜索时需要 teamId");

  const librariesToSearch =
    scope === "personal"
      ? await listAccessibleLibraries(actorId, "personal")
      : scope === "team"
        ? await listAccessibleLibraries(actorId, "team", input.teamId)
        : [
            ...(await listAccessibleLibraries(actorId, "personal")),
            ...(await listAccessibleLibraries(actorId, "team")),
          ];

  const limit = Math.min(Math.max(input.limit ?? 20, 1), SEARCH_ITEM_LIMIT);
  const items: (LibraryItemBrief & { libraryLabel: string; scope: string; teamId: string | null })[] = [];
  const folders: (LibraryFolderBrief & { libraryLabel: string; scope: string; teamId: string | null })[] = [];

  for (const lib of librariesToSearch) {
    if (items.length >= limit && folders.length >= SEARCH_FOLDER_LIMIT) break;
    const view = await listLibraryContents(actorId, lib.ref, null, {
      q: query,
      type: "all",
      sort: "modified",
      dir: "desc",
    });
    for (const folder of view.folders) {
      if (folders.length >= SEARCH_FOLDER_LIMIT) break;
      folders.push({
        folderId: folder.id,
        name: folder.name,
        parentId: folder.parentId,
        isDefault: folder.isDefault,
        path: folder.path ?? "",
        itemCount: folder.itemCount,
        updatedAt: folder.updatedAt.toISOString(),
        libraryLabel: lib.label,
        scope: lib.ref.kind,
        teamId: lib.teamId,
      });
    }
    for (const item of view.items) {
      if (items.length >= limit) break;
      items.push({
        ...itemBrief(item),
        libraryLabel: lib.label,
        scope: lib.ref.kind,
        teamId: lib.teamId,
      });
    }
  }

  return {
    query,
    scope,
    librariesSearched: librariesToSearch.length,
    items,
    folders,
    hint:
      items.length === 0 && folders.length === 0
        ? "没有匹配的文件或文件夹；可以换个关键词，或用 browse_library 逐层查看。"
        : "资源库搜索按文件名匹配（不区分大小写），不搜索文件正文。",
  };
}

/** 我的全部资源库概览：工作台助手快照与 list_libraries 共用 */
export async function myLibrariesSummary(actorId: string) {
  const teams = await listMyTeams(actorId);
  const summary = await getDashboardLibrarySummary(
    actorId,
    teams.map((t) => ({ id: t.id, name: t.name })),
  );
  return {
    personalCount: summary.personalCount,
    teams: summary.teams.map((t) => ({
      teamId: t.id,
      teamName: t.name,
      itemCount: t.itemCount,
    })),
    totalCount: summary.totalCount,
    recent: summary.recent.map((f) => ({
      itemId: f.id,
      filename: f.filename,
      size: f.size,
      updatedAt: f.updatedAt.toISOString(),
      scope: f.scope,
      teamId: f.teamId ?? null,
      libraryLabel: f.teamName,
    })),
  };
}

// ------------------------------------------------------------------ 读文件正文 / 预览 / 编辑

export async function readLibraryFileText(
  actorId: string,
  itemId: string,
  version?: number,
): Promise<
  | ({
      itemId: string;
      version: number;
      filename: string;
      mimeType: string | null;
      size: number;
    } & ExtractedFileText)
  | {
      itemId: string;
      version: number;
      filename: string;
      mimeType: string | null;
      size: number;
      note: string;
    }
> {
  const ref = await getLibraryFileRef(actorId, itemId, version);
  const base = {
    itemId,
    version: ref.version,
    filename: ref.filename,
    mimeType: ref.mimeType,
    size: ref.size,
  };
  if (ref.size > READ_TEXT_MAX_BYTES) {
    return {
      ...base,
      note: `文件较大（${Math.ceil(ref.size / 1024 / 1024)}MB），超过 32MB 的正文解析上限。请改用 open_library_file 预览或下载。`,
    };
  }
  const data = await readStoredContent(
    { storageKey: ref.storageKey },
    READ_TEXT_MAX_BYTES,
  );
  const extracted = await extractFileText({
    filename: ref.filename,
    mimeType: ref.mimeType,
    data,
  });
  return { ...base, ...extracted };
}

/** 预览信封：与 open_file 同形态，客户端弹同一个预览弹窗 */
export async function libraryFileOpenEnvelope(
  actorId: string,
  itemId: string,
  version?: number,
) {
  const ref = await getLibraryFileRef(actorId, itemId, version);
  const qs = version ? `?version=${ref.version}` : "";
  return {
    __showFile: true as const,
    url: `/api/library/items/${itemId}/content${qs}`,
    filename: ref.filename,
    mimeType: ref.mimeType,
    size: ref.size,
  };
}

/** 在线编辑：懒创建 documents 行后跳到编辑页；格式不支持时 ensureDocument 会报错 */
export async function editLibraryFileEnvelope(actorId: string, itemId: string) {
  const access = await requireLibraryItemAccess(actorId, itemId);
  if (!access.canEdit) throw new ForbiddenError("你没有该资源库文件的编辑权限");
  const doc = await ensureDocument(actorId, "library_item", itemId);
  return {
    __navigate: true as const,
    label: `资源库文件「${access.item.filename}」`,
    href: `/documents/${doc.document.id}`,
  };
}

export async function listItemVersionsForAgent(actorId: string, itemId: string) {
  const access = await requireLibraryItemAccess(actorId, itemId);
  const versions = await listItemVersions(itemId, 100);
  return {
    itemId,
    filename: access.item.filename,
    currentVersion: access.item.currentVersion,
    versions: versions.map((v) => ({
      version: v.version,
      filename: v.filename,
      mimeType: v.mimeType,
      size: v.size,
      note: v.note,
      noteLabel: NOTE_LABELS[v.note] ?? v.note,
      origin: v.origin,
      originLabel: ORIGIN_LABELS[v.origin as keyof typeof ORIGIN_LABELS] ?? v.origin,
      creatorName: v.creatorName,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

// ------------------------------------------------------------------ 条目 / 文件夹信息（拟稿展示用）

async function libraryLabelOfRow(library: LibraryRow): Promise<string> {
  if (library.kind === "personal") return "个人资源库";
  if (!library.teamId) return "团队资源库";
  return `${await teamNameOf(library.teamId)} · 团队资源库`;
}

async function folderPathOf(
  libraryId: string,
  folderId: string | null,
): Promise<string> {
  if (!folderId) return "";
  const crumbs = await folderBreadcrumbs(libraryId, folderId);
  return crumbs.map((c) => c.name).join(" / ");
}

export type LibraryItemInfo = {
  itemId: string;
  filename: string;
  folderId: string | null;
  folderPath: string;
  size: number;
  currentVersion: number;
  libraryLabel: string;
  scope: "personal" | "team";
  teamId: string | null;
};

export async function describeLibraryItem(
  actorId: string,
  itemId: string,
): Promise<LibraryItemInfo> {
  const access = await requireLibraryItemAccess(actorId, itemId);
  return {
    itemId,
    filename: access.item.filename,
    folderId: access.item.folderId,
    folderPath: await folderPathOf(access.library.id, access.item.folderId),
    size: access.item.size,
    currentVersion: access.item.currentVersion,
    libraryLabel: await libraryLabelOfRow(access.library),
    scope: access.library.kind as "personal" | "team",
    teamId: access.library.teamId,
  };
}

export type LibraryFolderInfo = {
  folderId: string;
  name: string;
  parentId: string | null;
  path: string;
  isDefault: boolean;
  libraryId: string;
  libraryLabel: string;
  scope: "personal" | "team";
  teamId: string | null;
};

export async function describeLibraryFolder(
  actorId: string,
  folderId: string,
): Promise<LibraryFolderInfo> {
  const [row] = await db
    .select({ folder: libraryFolders, library: libraries })
    .from(libraryFolders)
    .innerJoin(libraries, eq(libraryFolders.libraryId, libraries.id))
    .where(eq(libraryFolders.id, folderId));
  if (!row) throw new AppError("文件夹不存在");

  const ref = libraryRefOf(row.library);
  const access = await getLibraryAccess(actorId, ref);
  if (!access) throw new ForbiddenError("资源库不存在或你没有访问权限");

  const path = await folderPathOf(row.library.id, folderId);
  return {
    folderId,
    name: row.folder.name,
    parentId: row.folder.parentId,
    path,
    isDefault: row.folder.isDefault,
    libraryId: row.library.id,
    libraryLabel: await libraryLabelOfRow(row.library),
    scope: row.library.kind as "personal" | "team",
    teamId: row.library.teamId,
  };
}

/** 目标文件夹必须属于目标库，并给出显示路径 */
export async function describeTargetFolder(
  library: LibraryRow,
  folderId: string | null | undefined,
): Promise<{ folderId: string | null; path: string }> {
  if (folderId === undefined || folderId === null) {
    return { folderId: null, path: "" };
  }
  await assertFolderInLibrary(db, library.id, folderId);
  return { folderId, path: await folderPathOf(library.id, folderId) };
}

/**
 * 拟稿时把「没指定文件夹」落成具体的默认文件夹，卡片上才能显示真实路径。
 * 保存助手文件 = 个人库「助手生成」/ 团队库「手动上传」；
 * 复制文件 = 两个库都用「手动上传」（它不再算助手生成的产物）。
 */
export async function resolveSaveFolder(
  library: LibraryRow,
  scope: "personal" | "team",
  folderId: string | null | undefined,
  fallback?: "agent" | "manual",
): Promise<{ folderId: string | null; path: string }> {
  if (folderId !== undefined) return describeTargetFolder(library, folderId);
  const key = fallback ?? (scope === "personal" ? "agent" : "manual");
  const id = await getDefaultFolderId(library, key);
  return describeTargetFolder(library, id);
}

// ------------------------------------------------------------------ 写实现（commit 调用）

function normalizeFilename(raw: string): string {
  const name = raw.trim().replace(/[\\/]/g, "");
  if (!name) throw new AppError("文件名不能为空");
  if (name.length > 200) throw new AppError("文件名不能超过 200 个字符");
  return name;
}

/**
 * 保存助手对话里的文件（上传或 create_file 生成）到资源库。
 * - 个人库缺省落到「助手生成」文件夹，团队库缺省落到「手动上传」；
 * - 同名同文件夹会追加为新版本（与手动上传一致）。
 */
export async function saveAgentFileToLibrary(
  actorId: string,
  input: {
    fileId: string;
    scope: "personal" | "team";
    teamId?: string | null;
    folderId?: string | null;
    filename?: string;
  },
) {
  const file = await getAgentFileForDownload(actorId, input.fileId);
  const scope = await resolveLibraryScope(actorId, input, { needEdit: true });
  const library = scope.library;

  const filename = normalizeFilename(input.filename ?? file.filename);
  const folderId =
    input.folderId === undefined
      ? await getDefaultFolderId(
          library,
          scope.ref.kind === "personal" ? "agent" : "manual",
        )
      : input.folderId;
  if (folderId) await assertFolderInLibrary(db, library.id, folderId);

  // 磁盘 blob 直接共享（删除时会做引用检查）；只有历史 data 行才另存一份
  let storageKey = file.storageKey;
  let size = file.size;
  let createdKey: string | null = null;
  if (!storageKey) {
    const blob = await saveBlobFromBuffer(Buffer.from(file.data), MAX_FILE_SIZE);
    storageKey = blob.storageKey;
    size = blob.size;
    createdKey = blob.storageKey;
  }

  try {
    const res = await db.transaction(async (tx) =>
      putVersionByName(tx, {
        library,
        folderId,
        filename,
        mimeType: file.mimeType,
        storageKey: storageKey!,
        size,
        note: "manual",
        origin: "agent",
        createdById: actorId,
        operationType: "item_saved_from_agent",
        operationNote: `来自助手对话文件 ${input.fileId}`,
      }),
    );
    return {
      ...res,
      filename,
      folderId,
      libraryLabel: scope.label,
      scope: scope.ref.kind,
      teamId: scope.ref.kind === "team" ? scope.ref.teamId : null,
    };
  } catch (e) {
    if (createdKey) await deleteBlob(createdKey);
    throw e;
  }
}

/** 资源库文件 → 任务附件：复制字节各存一份，之后两边互不影响 */
export async function copyLibraryItemToTask(
  actorId: string,
  itemId: string,
  taskId: string,
): Promise<{ id: string; filename: string }> {
  const ref = await getLibraryFileRef(actorId, itemId);
  const row = await uploadAttachment(actorId, taskId, {
    filename: ref.filename,
    mimeType: ref.mimeType,
    size: ref.size,
    storageKey: ref.storageKey,
  });
  return { id: row.id, filename: ref.filename };
}

/**
 * 资源库文件 → 助手对话附件（agent_files）：面板「从资源库选择」走这里。
 * 与任务附件不同，这里**共享** blob key（引用计数会兜住两边删除），
 * 用户随后就能用 read_file / send_message / save_file_to_task 继续操作它。
 */
export async function copyLibraryItemToAgentFile(
  actorId: string,
  itemId: string,
): Promise<{ id: string; filename: string; mimeType: string | null; size: number }> {
  const ref = await getLibraryFileRef(actorId, itemId);
  const [row] = await db
    .insert(agentFiles)
    .values({
      ownerId: actorId,
      filename: ref.filename,
      mimeType: ref.mimeType,
      size: ref.size,
      data: Buffer.alloc(0),
      storageKey: ref.storageKey,
    })
    .returning({
      id: agentFiles.id,
      filename: agentFiles.filename,
      mimeType: agentFiles.mimeType,
      size: agentFiles.size,
    });
  return row;
}

/**
 * 资源库文件复制到另一个库/文件夹（「拿出来编辑后放到别处」的落点）。
 * 目标位置已有同名文件时明确拒绝，避免悄悄合并成版本。
 */
export async function copyLibraryItem(
  actorId: string,
  input: {
    itemId: string;
    scope: "personal" | "team";
    teamId?: string | null;
    folderId?: string | null;
    filename?: string;
  },
) {
  const src = await getLibraryFileRef(actorId, input.itemId);
  const target = await resolveLibraryScope(actorId, input, { needEdit: true });
  const library = target.library;

  const filename = normalizeFilename(input.filename ?? src.filename);
  const folderId =
    input.folderId === undefined
      ? await getDefaultFolderId(library, "manual")
      : input.folderId;
  if (folderId) await assertFolderInLibrary(db, library.id, folderId);

  const existing = await findItemByName(db, library.id, folderId, filename);
  if (existing) {
    throw new AppError(
      existing.id === input.itemId
        ? "复制目标和原文件是同一个文件，请换个文件夹或文件名"
        : "目标位置已有同名文件，请给一个不同的文件名",
    );
  }

  const res = await db.transaction(async (tx) =>
    putVersionByName(tx, {
      library,
      folderId,
      filename,
      mimeType: src.mimeType,
      storageKey: src.storageKey,
      size: src.size,
      note: "manual",
      origin: "manual",
      createdById: actorId,
      operationType: "item_copied",
      operationNote: `复制自 ${src.filename}（v${src.version}）`,
    }),
  );
  return {
    ...res,
    filename,
    folderId,
    libraryLabel: target.label,
    scope: target.ref.kind,
    teamId: target.ref.kind === "team" ? target.ref.teamId : null,
  };
}

