import { NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { documentErrorResponse } from "@/lib/documents/http";
import { acquireLock, getLockView, releaseLock, touchLock } from "@/lib/documents/locks";
import { requireDocumentEdit } from "@/lib/documents/access";
import { broadcast } from "@/lib/documents/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ documentId: string }> };

const bodySchema = z.object({ sessionId: z.string().min(8).max(80) });

async function readSession(req: Request): Promise<string | null> {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  return parsed.success ? parsed.data.sessionId : null;
}

/** POST —— 获取单人编辑锁；被他人持有时 423 */
export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  const sessionId = await readSession(req);
  if (!sessionId) return NextResponse.json({ error: "会话标识不正确" }, { status: 400 });

  try {
    await requireDocumentEdit(documentId, session.user.id);
    const lock = await acquireLock(documentId, session.user.id, sessionId);
    if (!lock) {
      const held = await getLockView(documentId);
      return NextResponse.json(
        {
          error: held ? `${held.userName ?? "其他成员"}正在编辑该文档` : "编辑锁被占用",
          code: "LOCK_HELD",
          lock: held,
        },
        { status: 423 },
      );
    }
    broadcast(documentId, { type: "lock", lock });
    return NextResponse.json({ lock });
  } catch (e) {
    return documentErrorResponse(e);
  }
}

/** PATCH —— 续约；锁丢失返回 409 */
export async function PATCH(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  const sessionId = await readSession(req);
  if (!sessionId) return NextResponse.json({ error: "会话标识不正确" }, { status: 400 });

  try {
    const lock = await touchLock(documentId, session.user.id, sessionId);
    if (!lock) {
      return NextResponse.json({ error: "编辑锁已失效", code: "LOCK_LOST" }, { status: 409 });
    }
    return NextResponse.json({ lock });
  } catch (e) {
    return documentErrorResponse(e);
  }
}

/** DELETE —— 释放锁 */
export async function DELETE(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  const sessionId = new URL(req.url).searchParams.get("sessionId") ?? "";
  if (sessionId.length < 8 || sessionId.length > 80) {
    return NextResponse.json({ error: "会话标识不正确" }, { status: 400 });
  }
  try {
    await releaseLock(documentId, session.user.id, sessionId);
    const lock = await getLockView(documentId);
    broadcast(documentId, { type: "lock", lock });
    return new Response(null, { status: 204 });
  } catch (e) {
    return documentErrorResponse(e);
  }
}
