// 工作台布局的读写口。JSONB 列刻意不标类型（照 messages.tool_calls 先例），
// 进出都在这里过一次 normalize：读时兜底坏数据，写时纵深防御。

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { normalizeLayoutDoc, type DashboardLayoutDoc } from "./dashboard-layout";

/** 读用户的布局；NULL / 坏数据 → 默认布局，空 items 保留为空 */
export async function getDashboardLayout(userId: string): Promise<DashboardLayoutDoc> {
  const [row] = await db
    .select({ dashboardLayout: users.dashboardLayout })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return normalizeLayoutDoc(row?.dashboardLayout ?? null);
}

/** 落库前再归一一次，返回实际存下的布局（调用方可据此对齐本地状态） */
export async function saveDashboardLayout(
  userId: string,
  doc: DashboardLayoutDoc,
): Promise<DashboardLayoutDoc> {
  const normalized = normalizeLayoutDoc(doc);
  await db.update(users).set({ dashboardLayout: normalized }).where(eq(users.id, userId));
  return normalized;
}
