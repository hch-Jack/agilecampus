import { NextResponse } from "next/server";
import {
  AppError,
  DocumentLockError,
  ForbiddenError,
  VersionConflictError,
} from "@/lib/errors";

/** 文档写接口的同源校验：浏览器带 Origin 时必须与请求 host 一致 */
export function assertSameOrigin(req: Request): void {
  const origin = req.headers.get("origin");
  if (!origin) return;
  const host = req.headers.get("host");
  if (!host) return;
  try {
    if (new URL(origin).host !== host) throw new ForbiddenError("跨站请求被拒绝");
  } catch {
    throw new ForbiddenError("跨站请求被拒绝");
  }
}

/** 统一的文档接口错误映射；未知错误继续抛给 Next */
export function documentErrorResponse(e: unknown): Response {
  if (e instanceof VersionConflictError) {
    return NextResponse.json(
      { error: e.message, code: "VERSION_CONFLICT", currentVersion: e.currentVersion },
      { status: 409 },
    );
  }
  if (e instanceof DocumentLockError) {
    return NextResponse.json(
      {
        error: e.message,
        code:
          e.reason === "held"
            ? "LOCK_HELD"
            : e.reason === "lost"
              ? "LOCK_LOST"
              : "COLLABORATION_ENABLED",
      },
      { status: e.reason === "held" ? 423 : 409 },
    );
  }
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: e.message }, { status: 403 });
  }
  if (e instanceof AppError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  throw e;
}
