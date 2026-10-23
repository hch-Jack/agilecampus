"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  COUNTDOWN_TITLE_MAX_LENGTH,
  GRID_COLUMNS,
  NOTE_MAX_LENGTH,
  WIDGET_IDS,
  type DashboardLayoutDoc,
} from "@/lib/dashboard-layout";
import { saveDashboardLayout } from "@/lib/dashboard-layout-store";

export type SaveDashboardLayoutResult = { ok: true } | { error: string };

/**
 * 卡片数量上限：目录只有 15 张，留一点余量给未来版本；同时挡住超大数组。
 * （服务端 normalize 会去重、夹取、消解重叠，这里先把明显不像布局的输入挡在门外。）
 */
const MAX_ITEMS = 30;

const itemSchema = z.object({
  id: z.enum(WIDGET_IDS, "未知卡片"),
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
  config: z
    .object({
      text: z.string().max(NOTE_MAX_LENGTH * 4).optional(),
      title: z.string().max(COUNTDOWN_TITLE_MAX_LENGTH * 4).optional(),
      targetAt: z.string().max(32).optional(),
    })
    .optional(),
});

const envelopeSchema = z.object({
  v: z.literal(1),
  items: z.array(itemSchema).max(MAX_ITEMS),
});

/**
 * 保存当前用户的工作台布局。
 *
 * - 身份只从 session 取，绝不接受客户端传入的 userId；
 * - 坐标/尺寸的最终裁决权在 `normalizeLayoutDoc`（夹取、去重、统计互斥、碰撞消解），
 *   这里只做结构与明显越界的校验；
 * - **不 revalidate**：客户端正处在编辑态，整页回流会用服务端旧数据覆盖本地未保存的改动。
 */
export async function saveDashboardLayoutAction(payload: unknown): Promise<SaveDashboardLayoutResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = envelopeSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue?.message || "布局数据无效" };
  }

  // 结构已过 zod；越界数值交给 normalize（与客户端同一套规则）
  const doc: DashboardLayoutDoc = {
    v: 1,
    items: parsed.data.items.map((item) => ({
      id: item.id,
      x: item.x,
      y: item.y,
      w: Math.min(item.w, GRID_COLUMNS),
      h: item.h,
      ...(item.config ? { config: item.config } : {}),
    })),
  };

  await saveDashboardLayout(session.user.id, doc);
  return { ok: true };
}
