import type { DbExec } from "@/lib/documents/types";
import type { libraryFolders, libraryItems, libraries } from "@/db/schema";

/** 个人库 / 团队库的统一入参 */
export type LibraryRef =
  | { kind: "personal"; userId: string }
  | { kind: "team"; teamId: string };

export type LibraryKind = "team" | "personal";

export type LibraryRow = typeof libraries.$inferSelect;
export type LibraryFolderRow = typeof libraryFolders.$inferSelect;
export type LibraryItemRow = typeof libraryItems.$inferSelect;

/** 条目/版本来源：任务、私信、群聊、助手、AI、手动；mixed 表示同名合并了多来源 */
export type LibraryOrigin = "manual" | "task" | "dm" | "group" | "agent" | "ai" | "mixed";

export type LibrarySortField = "name" | "modified" | "size" | "type";
export type LibrarySortDir = "asc" | "desc";

export type LibraryQuery = {
  /** 文件名搜索（当前文件夹及其子文件夹） */
  q?: string;
  /** 文件类型筛选；all = 不筛选 */
  type?: import("./file-kind").LibraryFileType;
  sort?: LibrarySortField;
  dir?: LibrarySortDir;
};

export type LibraryVersionNote =
  | "initial"
  | "import"
  | "sync"
  | "upload"
  | "manual"
  | "autosave"
  | "restore"
  | "save_as";

export type LibrarySyncMode = "live" | "snapshot";

/** 默认文件夹的稳定键（名称是展示文案，键用于服务端定位） */
export type DefaultFolderKey = "task" | "dm" | "group" | "agent" | "manual";

export const DEFAULT_FOLDER_NAMES: Record<
  LibraryKind,
  Partial<Record<DefaultFolderKey, string>>
> = {
  personal: {
    task: "任务附件",
    dm: "私信",
    group: "群聊",
    agent: "助手生成",
    manual: "手动上传",
  },
  team: {
    task: "任务附件",
    group: "群文件",
    manual: "手动上传",
  },
};

export const ORIGIN_LABELS: Record<LibraryOrigin, string> = {
  manual: "手动上传",
  task: "任务附件",
  dm: "私信",
  group: "群聊",
  agent: "助手文件",
  ai: "AI 生成",
  mixed: "多来源",
};

export const NOTE_LABELS: Record<string, string> = {
  initial: "初始版本",
  import: "首次汇总",
  sync: "来源同步",
  manual: "手动保存",
  autosave: "自动保存",
  restore: "恢复历史",
  save_as: "另存为",
  upload: "上传",
};

export type LibraryFolderView = {
  id: string;
  name: string;
  isDefault: boolean;
  parentId: string | null;
  itemCount: number;
  updatedAt: Date;
  /** 搜索结果显示用：从根到该文件夹的路径 */
  path?: string;
};

export type LibraryItemView = {
  id: string;
  folderId: string;
  filename: string;
  mimeType: string | null;
  size: number;
  currentVersion: number;
  origin: LibraryOrigin;
  updatedAt: Date;
  /** 当前版本的操作者与时间（列表角标用） */
  currentActorName: string | null;
  currentCreatedAt: Date | null;
  versionCount: number;
  /** 绑定来源的同步模式集合（live 优先展示） */
  live: boolean;
  /** 搜索结果显示用：所在文件夹路径 */
  folderPath?: string;
};

export type LibraryBreadcrumb = { id: string; name: string };

export type LibraryView = {
  library: LibraryRow;
  folder: LibraryFolderRow | null;
  breadcrumbs: LibraryBreadcrumb[];
  folders: LibraryFolderView[];
  items: LibraryItemView[];
  canEdit: boolean;
  /** 当前生效的搜索/排序条件（浏览器控件回显） */
  query: {
    q: string;
    type: import("./file-kind").LibraryFileType;
    sort: LibrarySortField;
    dir: LibrarySortDir;
  };
  /** true = 结果来自搜索（跨当前文件夹及子文件夹），false = 普通目录浏览 */
  searching: boolean;
};

export type LibraryItemAccess = {
  item: LibraryItemRow;
  library: LibraryRow;
  role: "admin" | "teacher" | "student" | null;
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
};

export type LibraryVersionView = {
  version: number;
  filename: string;
  mimeType: string | null;
  size: number;
  note: string;
  origin: LibraryOrigin;
  createdById: string | null;
  creatorName: string | null;
  createdAt: Date;
};

export type LibraryOperationView = {
  id: string;
  itemId: string | null;
  type: string;
  oldValue: string | null;
  newValue: string | null;
  note: string | null;
  actorName: string;
  createdAt: Date;
};

/** 版本写入的唯一入参（appendLibraryVersion） */
export type AppendVersionInput = {
  storageKey: string;
  size: number;
  mimeType: string | null;
  filename?: string;
  editorState?: unknown;
  note: LibraryVersionNote;
  origin: LibraryOrigin;
  createdById: string | null;
  /** 操作日志类型；不传则不写日志 */
  operationType?: string;
  operationNote?: string;
  /** 来源幂等键；同一 item 内重复会被忽略 */
  sourceKey?: string;
  /** 指定版本号（文档镜像用）；不传则 item.currentVersion + 1 */
  version?: number;
  /** 保留来源时间（首次汇总/文档镜像）；不传则用库时钟 */
  createdAt?: Date;
};

export type LibraryExec = DbExec;
