import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { ForbiddenError } from "@/lib/errors";
import {
  getDocumentState,
  listTeamMembersForDocument,
} from "@/lib/documents/service";
import { DocumentEditor } from "@/components/documents/document-editor";
import type { DocumentEditorInitial } from "@/components/documents/editor-types";

export const dynamic = "force-dynamic";

/**
 * 在线文档编辑页。独立全屏路由（不复用预览弹窗）：固定工具栏、侧栏、
 * 冲突对话框与可刷新 URL 都需要稳定的页面级状态。
 */
export default async function DocumentEditorPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const { documentId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(documentId).success) notFound();

  let state: Awaited<ReturnType<typeof getDocumentState>>;
  try {
    state = await getDocumentState(documentId, session.user.id);
  } catch (e) {
    // 不存在 / 无权读 / 来源已删除统一 404，不泄露存在性
    if (e instanceof ForbiddenError) notFound();
    throw e;
  }

  const { access } = state;
  const members = access.canManage ? await listTeamMembersForDocument(access) : [];

  const initial: DocumentEditorInitial = {
    document: {
      id: access.document.id,
      sourceType: access.document.sourceType,
      sourceId: access.document.sourceId,
      taskId: access.document.taskId,
      format: access.document.format,
      filename: access.document.filename,
      mimeType: access.document.mimeType,
      currentVersion: access.document.currentVersion,
      collaborationEnabled: access.document.collaborationEnabled,
      createdById: access.document.createdById,
    },
    source: {
      filename: access.source.filename,
      mimeType: access.source.mimeType,
      size: access.source.size,
      ownerUserId: access.source.ownerUserId,
      taskId: access.source.taskId,
      projectId: access.source.projectId,
    },
    canEdit: access.canEdit,
    canManage: access.canManage,
    editVia: access.editVia,
    role: access.role,
    lock: state.lock,
    editorState: state.editorState,
    versions: state.versions.map((v) => ({
      version: v.version,
      filename: v.filename,
      size: v.size,
      note: v.note,
      creatorName: v.creatorName,
      createdAt: v.createdAt.toISOString(),
    })),
    editors: state.editors,
    members,
    contentUrl: `/api/documents/${documentId}/content`,
    currentUserId: session.user.id,
    currentUserName: session.user.name ?? "我",
  };

  return <DocumentEditor initial={initial} />;
}
