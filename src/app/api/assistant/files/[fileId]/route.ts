import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { deleteAgentFile, getAgentFileForDownload } from "@/lib/agent/files";
import { AppError } from "@/lib/errors";

type Ctx = { params: Promise<{ fileId: string }> };

function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

// 下载：只有文件主人能取（agent_files 没有项目/会话共享语义）。
// 恒为 attachment 响应 + nosniff：不允许 HTML/SVG 借这个口子内联执行。
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { fileId } = await ctx.params;
  if (!z.uuid().safeParse(fileId).success)
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });

  try {
    const file = await getAgentFileForDownload(session.user.id, fileId);
    const body = Uint8Array.from(file.data);
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(body.byteLength),
        "Content-Disposition": contentDisposition(file.filename),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}

// 删除：用户在发送前撤掉上传错的文件，或清掉不再需要的历史文件。
// 已经落进消息附件快照的 id 删掉后，聊天里的胶囊仍显示文件名，点下载会 404。
export async function DELETE(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "未登录" }, { status: 401 });

  const { fileId } = await ctx.params;
  if (!z.uuid().safeParse(fileId).success)
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });

  try {
    await deleteAgentFile(session.user.id, fileId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
