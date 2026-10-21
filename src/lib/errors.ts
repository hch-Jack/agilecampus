// 可预期业务错误：message 可直接展示给用户
export class AppError extends Error {}

export class ForbiddenError extends AppError {
  constructor(message = "没有权限执行此操作") {
    super(message);
  }
}

/**
 * 「不存在，或存在但不属于你」——个人资源的写/读入口用同一句话，
 * 免得靠 404/403 的差别把别人的会话 id 是否存在泄露出去。
 */
export class NotFoundError extends AppError {
  constructor(message = "不存在") {
    super(message);
  }
}

// postgres 唯一键冲突。drizzle 会把驱动错误包装为 DrizzleQueryError（code 在 cause 上），故两处都查
export function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string }).code ?? ((e as { cause?: { code?: string } }).cause?.code);
  return code === "23505";
}
