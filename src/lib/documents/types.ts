import type { DbTx } from "@/db";
import { db } from "@/db";

/**
 * 在线文档编辑的类型契约。
 *
 * 这里刻意不依赖 React/Next，只依赖 DB 类型，方便 lib 层单测。
 * 未来接「总资源库」时新增一个 `DocumentSourceAdapter` 并注册即可，
 * 编辑器、版本、锁、SSE、权限面板都只认 `documentId` 与 `DocumentAccess`。
 */

export type DocumentFormat = "text" | "docx" | "sheet";

/** 来源侧可执行的事务/连接；adapter 必须用传进来的 exec 写库 */
export type DbExec = DbTx | typeof db;

export type TeamRoleLike = "admin" | "teacher" | "student";

/** 来源适配器加载后的快照：元数据 + 读权限已通过 + 管理权推导 */
export type LoadedDocumentSource = {
  sourceType: string;
  sourceId: string;
  format: DocumentFormat;
  filename: string;
  mimeType: string | null;
  size: number;
  /** 默认编辑/管理权的来源（任务附件 = 上传者） */
  ownerUserId: string;
  /** 上传者或团队 admin；由 adapter 实时推导 */
  canManage: boolean;
  role: TeamRoleLike | null;
  taskId: string | null;
  teamId: string | null;
  projectId: string | null;
};

export type SourceContent = {
  data: Buffer;
  filename: string;
  mimeType: string | null;
  size: number;
  storageKey: string | null;
};

export type StoredContentRef = {
  storageKey: string;
  size: number;
  mimeType: string | null;
  filename: string;
};

export type DocumentActivityEvent =
  | { type: "document_saved"; newValue: string }
  | { type: "document_saved_as"; newValue: string }
  | { type: "document_collaboration_changed"; newValue: string }
  | { type: "document_editor_granted"; newValue: string }
  | { type: "document_editor_revoked"; newValue: string };

/**
 * 文档来源适配器：把「文档」与「实际存放文件的地方」解耦。
 *
 * 约定：
 * - `load` 内完成读权限校验；不存在或无权读一律返回 null（不泄露存在性）。
 * - `replace` 必须真正更新来源行（任务附件 = 更新 storageKey/size/mime/data），
 *   并在来源已删除时抛错让事务回滚。
 * - `createCopy` 在来源侧创建一条新记录并返回新快照（另存为）。
 */
export interface DocumentSourceAdapter {
  readonly sourceType: string;

  load(userId: string, sourceId: string, exec?: DbExec): Promise<LoadedDocumentSource | null>;

  read(source: LoadedDocumentSource, maxBytes: number): Promise<SourceContent>;

  replace(exec: DbExec, source: LoadedDocumentSource, next: StoredContentRef): Promise<void>;

  createCopy(
    exec: DbExec,
    actorId: string,
    source: LoadedDocumentSource,
    next: StoredContentRef,
  ): Promise<LoadedDocumentSource>;

  recordActivity(
    exec: DbExec,
    actorId: string,
    source: LoadedDocumentSource,
    event: DocumentActivityEvent,
  ): Promise<void>;

  /** 文档/来源删除时的额外清理（blob 由 documents 服务统一删除） */
  onDocumentDeleted?(
    exec: DbExec,
    source: LoadedDocumentSource,
    versionStorageKeys: string[],
  ): Promise<void>;
}

// ------------------------------------------------------------------ 访问结果

export type DocumentRecord = {
  id: string;
  sourceType: string;
  sourceId: string;
  taskId: string | null;
  format: DocumentFormat;
  filename: string;
  mimeType: string | null;
  currentVersion: number;
  collaborationEnabled: boolean;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EditVia = "owner" | "admin" | "grant" | null;

export type DocumentAccess = {
  document: DocumentRecord;
  source: LoadedDocumentSource;
  canEdit: boolean;
  canManage: boolean;
  editVia: EditVia;
  role: TeamRoleLike | null;
};

// ------------------------------------------------------------------ 协作/锁

export type LockView = {
  userId: string;
  userName: string | null;
  sessionId: string;
  acquiredAt: string;
  expiresAt: string;
};

export type PresenceUser = {
  userId: string;
  name: string;
};

export type DocumentEvent =
  | {
      type: "hello";
      version: number;
      collaborationEnabled: boolean;
      lock: LockView | null;
      users: PresenceUser[];
    }
  | { type: "presence"; users: PresenceUser[] }
  | {
      type: "saved";
      version: number;
      actorId: string;
      actorName: string;
      savedAt: string;
      note: string | null;
    }
  | { type: "settings"; collaborationEnabled: boolean; actorId: string }
  | { type: "permission"; userId: string; canEdit: boolean }
  | { type: "lock"; lock: LockView | null }
  | { type: "revoked"; reason: string };
