import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AI_HISTORY_LIMIT_DEFAULT, normalizeAiHistoryLimit } from "./history-limit";

/**
 * 助手「记得多少上文」的**存取**——偏好存在 `users.ai_history_limit`（要读库，只在服务端用；
 * 常量与钳制在 lib/agent/history-limit.ts）。
 *
 * 一个数供两个 scope 共用：工作台助手（personal）与项目页助手（project）读的是同一条偏好。
 * 之所以不做成「每个会话一个数」：个人会话是懒建的（首轮发言才建），要存偏好就得先建会话；
 * 而项目会话是共享的，让每个人的记忆条数各存一份反而更难解释。
 */

/** 读偏好。查不到人（已注销等）就退回默认值，别把整个回合带崩 */
export async function getAiHistoryLimit(userId: string): Promise<number> {
  const [row] = await db
    .select({ limit: users.aiHistoryLimit })
    .from(users)
    .where(eq(users.id, userId));
  return normalizeAiHistoryLimit(row?.limit ?? AI_HISTORY_LIMIT_DEFAULT);
}

/** 写偏好：钳制后再落库，返回真正生效的值（界面据此回显） */
export async function setAiHistoryLimit(userId: string, value: unknown): Promise<number> {
  const limit = normalizeAiHistoryLimit(value);
  await db.update(users).set({ aiHistoryLimit: limit }).where(eq(users.id, userId));
  return limit;
}
