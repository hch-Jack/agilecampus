import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documentEditors, documents, type TeamRole } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import { getTeamMembership } from "@/lib/team";
import { getDocumentSourceAdapter, hasDocumentSourceAdapter } from "./registry";
import type { DocumentAccess, DocumentFormat, DocumentRecord, EditVia } from "./types";

/**
 * 文档访问判定。
 *
 * 顺序：文档存在 → 来源已注册 → 来源适配器完成「读权限」校验 →
 * 文档级额外授权 + 来源管理权。无权读与不存在都返回 null，
 * 上层统一按 404 处理，不泄露文档是否存在。
 */
export async function getDocumentAccess(
  documentId: string,
  userId: string,
): Promise<DocumentAccess | null> {
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) return null;
  if (!hasDocumentSourceAdapter(doc.sourceType)) return null;

  const adapter = getDocumentSourceAdapter(doc.sourceType);
  const source = await adapter.load(userId, doc.sourceId);
  if (!source) return null;

  const [grant] = await db
    .select({ userId: documentEditors.userId })
    .from(documentEditors)
    .where(and(eq(documentEditors.documentId, documentId), eq(documentEditors.userId, userId)));

  const isOwner = source.ownerUserId === userId;
  const isAdmin = source.role === "admin";
  const viaGrant = Boolean(grant);
  const editVia: EditVia = isOwner ? "owner" : isAdmin ? "admin" : viaGrant ? "grant" : null;

  return {
    document: toDocumentRecord(doc),
    source,
    canEdit: source.canManage || viaGrant,
    canManage: source.canManage,
    editVia,
    role: (source.role as TeamRole | null) ?? null,
  };
}

export async function requireDocumentAccess(
  documentId: string,
  userId: string,
): Promise<DocumentAccess> {
  const access = await getDocumentAccess(documentId, userId);
  if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
  return access;
}

export async function requireDocumentEdit(
  documentId: string,
  userId: string,
): Promise<DocumentAccess> {
  const access = await requireDocumentAccess(documentId, userId);
  if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");
  return access;
}

export async function requireDocumentManage(
  documentId: string,
  userId: string,
): Promise<DocumentAccess> {
  const access = await requireDocumentAccess(documentId, userId);
  if (!access.canManage) throw new ForbiddenError("只有上传者或团队管理员可以管理该文档");
  return access;
}

/** 授予编辑权前：目标必须是来源所在团队的成员 */
export async function assertTeamMemberForDocument(
  access: DocumentAccess,
  targetUserId: string,
): Promise<void> {
  if (!access.source.teamId) throw new ForbiddenError("该文档不属于任何团队");
  const member = await getTeamMembership(targetUserId, access.source.teamId);
  if (!member) throw new ForbiddenError("目标用户不是该团队成员");
}

function toDocumentRecord(doc: typeof documents.$inferSelect): DocumentRecord {
  return {
    id: doc.id,
    sourceType: doc.sourceType,
    sourceId: doc.sourceId,
    taskId: doc.taskId,
    format: doc.format as DocumentFormat,
    filename: doc.filename,
    mimeType: doc.mimeType,
    currentVersion: doc.currentVersion,
    collaborationEnabled: doc.collaborationEnabled,
    createdById: doc.createdById,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
