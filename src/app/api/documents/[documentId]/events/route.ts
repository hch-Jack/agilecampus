import { randomUUID } from "node:crypto";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import {
  broadcast,
  broadcastPresence,
  presence,
  subscribe,
  type Subscriber,
} from "@/lib/documents/events";
import { getLockView } from "@/lib/documents/locks";
import type { DocumentEvent } from "@/lib/documents/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ documentId: string }> };

/**
 * GET /api/documents/[documentId]/events —— SSE 长连接。
 *
 * 单进程 standalone 部署意味着事件只在当前进程内广播（见 events.ts 注释）。
 * 15s 心跳注释防中间层超时；每 60s 复核一次读权限，被移出团队/文档删除时
 * 主动发 revoked 并断开。客户端 EventSource 断线会自动重连。
 */
export async function GET(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return new Response("未登录", { status: 401 });

  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return new Response("文档不存在", { status: 404 });
  }

  const access = await getDocumentAccess(documentId, session.user.id);
  if (!access) return new Response("文档不存在", { status: 404 });

  const lock = await getLockView(documentId);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let accessCheck: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;

      const close = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (accessCheck) clearInterval(accessCheck);
        unsubscribe?.();
        req.signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          // 已关闭
        }
      };

      const send = (event: DocumentEvent) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      const cleanup = () => {
        if (closed) return;
        close();
        broadcastPresence(documentId);
      };

      const subscriber: Subscriber = {
        id: randomUUID(),
        userId: session.user.id,
        name: session.user.name ?? "成员",
        send,
        close: cleanup,
      };
      unsubscribe = subscribe(documentId, subscriber);

      send({
        type: "hello",
        version: access.document.currentVersion,
        collaborationEnabled: access.document.collaborationEnabled,
        lock,
        users: presence(documentId),
      });
      broadcast(documentId, { type: "presence", users: presence(documentId) });

      heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          cleanup();
        }
      }, 15_000);

      accessCheck = setInterval(async () => {
        if (closed) return;
        const latest = await getDocumentAccess(documentId, session.user.id).catch(() => null);
        if (!latest) {
          send({ type: "revoked", reason: "你已无权查看该文档" });
          cleanup();
        }
      }, 60_000);

      req.signal.addEventListener("abort", cleanup, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
