import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { browseLibrary } from "@/lib/agent/library";
import { AppError, ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  scope: z.enum(["personal", "team"]).default("personal"),
  teamId: z.uuid().optional(),
  folderId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
});

/**
 * GET /api/library/browse?scope=&teamId=&folderId=&q=
 * 助手面板「从资源库选择附件」用的目录浏览接口。权限与页面同口径（lib/agent/library.ts），
 * 返回当前文件夹的子文件夹与文件（含 itemId）。浏览前会做一次 15 秒节流同步。
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const sp = new URL(req.url).searchParams;
  const parsed = querySchema.safeParse({
    scope: sp.get("scope") ?? "personal",
    teamId: sp.get("teamId") ?? undefined,
    folderId: sp.get("folderId") ?? undefined,
    q: sp.get("q") ?? undefined,
  });
  if (!parsed.success)
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  if (parsed.data.scope === "team" && !parsed.data.teamId)
    return NextResponse.json({ error: "团队资源库需要 teamId" }, { status: 400 });

  try {
    const view = await browseLibrary(session.user.id, {
      scope: parsed.data.scope,
      teamId: parsed.data.teamId,
      folderId: parsed.data.folderId ?? null,
      q: parsed.data.q,
    });
    return NextResponse.json({
      library: view.library,
      folder: view.folder,
      breadcrumbs: view.breadcrumbs,
      folders: view.folders.map((f) => ({
        folderId: f.folderId,
        name: f.name,
        path: f.path,
        itemCount: f.itemCount,
      })),
      items: view.items.map((i) => ({
        itemId: i.itemId,
        filename: i.filename,
        mimeType: i.mimeType,
        size: i.size,
        typeLabel: i.typeLabel,
        updatedAt: i.updatedAt,
      })),
      searching: view.searching,
    });
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/library/browse] 失败:", e);
    return NextResponse.json({ error: "读取资源库失败，请重试" }, { status: 500 });
  }
}
