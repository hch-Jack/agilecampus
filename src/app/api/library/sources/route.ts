import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { myLibrariesSummary } from "@/lib/agent/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/library/sources
 * 我的资源库来源列表：个人库 + 各团队库（含文件数），供助手面板的「从资源库选择」切换。
 */
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  try {
    return NextResponse.json(await myLibrariesSummary(session.user.id));
  } catch (e) {
    console.error("[/api/library/sources] 失败:", e);
    return NextResponse.json({ error: "读取资源库失败，请重试" }, { status: 500 });
  }
}
