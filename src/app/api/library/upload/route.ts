import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { LibraryRef } from "@/lib/library/types";
import { uploadToLibrary } from "@/lib/library/upload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/library/upload?scope=personal|team&teamId=&folderId=&name=&type=
 * Body: 文件原始字节。流式落盘后在事务内写条目/版本。
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope");
  const teamId = url.searchParams.get("teamId") ?? "";
  // 缺省 = 默认「手动上传」文件夹；root = 资源库根目录
  const folderParam = url.searchParams.get("folderId");
  let folderId: string | null | undefined;
  if (folderParam === null) folderId = undefined;
  else if (folderParam === "root" || folderParam === "") folderId = null;
  else if (z.uuid().safeParse(folderParam).success) folderId = folderParam;
  else return NextResponse.json({ error: "上传目标文件夹不正确" }, { status: 400 });
  const filename = url.searchParams.get("name") ?? "";
  const mimeType = url.searchParams.get("type") || null;

  let ref: LibraryRef;
  if (scope === "personal") {
    ref = { kind: "personal", userId: session.user.id };
  } else if (scope === "team" && teamId) {
    ref = { kind: "team", teamId };
  } else {
    return NextResponse.json({ error: "上传目标不正确" }, { status: 400 });
  }

  try {
    const result = await uploadToLibrary(session.user.id, ref, {
      folderId,
      filename,
      mimeType,
      stream: req.body as ReadableStream<Uint8Array>,
    });
    return NextResponse.json({ ...result, id: result.itemId });
  } catch (e) {
    if (e instanceof ForbiddenError)
      return NextResponse.json({ error: e.message }, { status: 403 });
    if (e instanceof AppError)
      return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/library/upload] 上传失败:", e);
    return NextResponse.json({ error: "上传失败，请重试" }, { status: 500 });
  }
}
