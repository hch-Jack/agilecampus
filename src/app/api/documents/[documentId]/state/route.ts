import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { documentErrorResponse } from "@/lib/documents/http";
import {
  getDocumentState,
  listTeamMembersForDocument,
} from "@/lib/documents/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ documentId: string }> };

/** GET /api/documents/[documentId]/state —— 编辑器初始化/冲突后用 */
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }

  try {
    const state = await getDocumentState(documentId, session.user.id);
    const members = state.access.canManage
      ? await listTeamMembersForDocument(state.access)
      : [];
    const { access } = state;
    return NextResponse.json({
      document: {
        ...access.document,
        createdAt: access.document.createdAt.toISOString(),
        updatedAt: access.document.updatedAt.toISOString(),
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
        ...v,
        createdAt: v.createdAt.toISOString(),
      })),
      editors: state.editors,
      members,
      contentUrl: `/api/documents/${documentId}/content`,
    });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
