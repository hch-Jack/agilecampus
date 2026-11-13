import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { documentErrorResponse } from "@/lib/documents/http";
import { readDocumentContent } from "@/lib/documents/service";
import { contentDisposition } from "@/lib/file-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ documentId: string }> };

/**
 * GET /api/documents/[documentId]/content?version=N
 * 返回原始字节（编辑初始化、历史版本下载共用）。恒为 attachment 响应。
 */
export async function GET(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }

  const versionRaw = new URL(req.url).searchParams.get("version");
  const version = versionRaw ? Number(versionRaw) : undefined;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    return NextResponse.json({ error: "版本号不正确" }, { status: 400 });
  }

  try {
    const content = await readDocumentContent(documentId, session.user.id, version);
    return new Response(Uint8Array.from(content.data), {
      headers: {
        "Content-Type": content.mimeType ?? "application/octet-stream",
        "Content-Length": String(content.data.length),
        "Content-Disposition": contentDisposition(content.filename),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
