import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  importAssistantMemory,
  MEMORY_IMPORT_MAX_BYTES,
} from "@/lib/agent/memory-transfer";
import { AppError } from "@/lib/errors";

// 记忆导入：请求体是导出文件的原样 JSON 文本。
// 先卡体积再解析 —— 文件可能来自别处，不能让它把服务打满；落库范围由
// importAssistantMemory 收口（只写发话人名下，条数/长度全有上限）。
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  // 先看声明的长度，别为一个超大文件把请求体整个读进内存
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MEMORY_IMPORT_MAX_BYTES)
    return NextResponse.json({ error: "记忆文件不能超过 5MB" }, { status: 413 });

  const text = await req.text();
  // 按字节算：中文字符 UTF-8 下占 3 字节，length 会低报体积
  if (Buffer.byteLength(text, "utf8") > MEMORY_IMPORT_MAX_BYTES)
    return NextResponse.json({ error: "记忆文件不能超过 5MB" }, { status: 413 });

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "不是有效的 JSON 文件" }, { status: 400 });
  }

  try {
    const result = await importAssistantMemory(session.user.id, raw);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: 400 });
    console.error("[/api/assistant/memory/import] 导入失败:", e);
    return NextResponse.json({ error: "导入失败，请重试" }, { status: 500 });
  }
}
