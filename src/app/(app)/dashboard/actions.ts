"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  CLOCK_MAX_ZONES,
  CLOCK_ZONE_MAX_LENGTH,
  COUNTDOWN_TITLE_MAX_LENGTH,
  GRID_COLUMNS,
  INSTANCE_ID_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  WIDGET_IDS,
  type DashboardLayoutDoc,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import { saveDashboardLayout } from "@/lib/dashboard-layout-store";
import { decideApproval, type ApprovalDecision } from "@/lib/approval";
import { AppError } from "@/lib/errors";
import { revalidatePath } from "next/cache";

export type SaveDashboardLayoutResult = { ok: true } | { error: string };

/**
 * 卡片数量上限：目录 18 张，可重复卡还能再加一些；留余量给未来版本。
 * （服务端 normalize 会去重、夹取、消解重叠，这里先把明显不像布局的输入挡在门外。）
 */
const MAX_ITEMS = 40;

const itemSchema = z
  .object({
    id: z.string().min(1).max(INSTANCE_ID_MAX_LENGTH),
    // 旧客户端只发 id（单例卡）；没有 type 时由 id 推断
    type: z.enum(WIDGET_IDS, "未知卡片").optional(),
    x: z.number().int(),
    y: z.number().int(),
    w: z.number().int(),
    h: z.number().int(),
    config: z
      .object({
        text: z.string().max(NOTE_MAX_LENGTH * 4).optional(),
        title: z.string().max(COUNTDOWN_TITLE_MAX_LENGTH * 4).optional(),
        targetAt: z.string().max(32).optional(),
        lunar: z.boolean().optional(),
        zones: z.array(z.string().max(CLOCK_ZONE_MAX_LENGTH)).max(CLOCK_MAX_ZONES * 4).optional(),
        // 日程表：显示开关与分区比例（最终夹取由 normalize 负责）
        showGantt: z.boolean().optional(),
        showPool: z.boolean().optional(),
        showCalendar: z.boolean().optional(),
        ganttRatio: z.number().min(0).max(1).optional(),
        poolRatio: z.number().min(0).max(1).optional(),
      })
      .optional(),
  })
  .refine((item) => item.type !== undefined || (WIDGET_IDS as readonly string[]).includes(item.id), {
    message: "未知卡片",
    path: ["type"],
  });

const envelopeSchema = z.object({
  v: z.literal(1),
  items: z.array(itemSchema).max(MAX_ITEMS),
});

/**
 * 保存当前用户的工作台布局。
 *
 * - 身份只从 session 取，绝不接受客户端传入的 userId；
 * - 坐标/尺寸的最终裁决权在 `normalizeLayoutDoc`（夹取、去重、碰撞消解），
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
      type: (item.type ?? item.id) as DashboardWidgetId,
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

// —— 待办审批卡片：通过 / 拒绝 ——

export type DecideApprovalResult = { ok: true } | { error: string };

const decideSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
});

/**
 * 审批人（老师/管理员任一）对一条申请给出决定。权限与状态校验在 lib/approval；
 * 成功后刷新工作台（卡片列表、未读角标随服务端回流）。
 */
export async function decideApprovalAction(
  input: unknown,
): Promise<DecideApprovalResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };

  try {
    await decideApproval(
      session.user.id,
      parsed.data.requestId,
      parsed.data.decision as ApprovalDecision,
    );
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard");
  return { ok: true };
}
