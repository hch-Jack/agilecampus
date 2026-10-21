import { NextResponse } from "next/server";
import { AppError, ForbiddenError, NotFoundError } from "@/lib/errors";

/**
 * 助手会话/消息这几条私有路由共用的错误映射。
 *
 * 顺序要紧：NotFound 与 Forbidden 都继承 AppError，必须先判子类。
 * 「不存在」与「存在但不属于你」统一走 404，不靠状态码泄露别人的会话是否存在。
 */
export function chatErrorResponse(e: unknown, tag: string) {
  if (e instanceof ForbiddenError) {
    return NextResponse.json({ error: "没有权限" }, { status: 403 });
  }
  if (e instanceof NotFoundError) {
    return NextResponse.json({ error: e.message }, { status: 404 });
  }
  if (e instanceof AppError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  console.error(`${tag} 失败:`, e);
  return NextResponse.json({ error: "操作失败，请重试" }, { status: 500 });
}
