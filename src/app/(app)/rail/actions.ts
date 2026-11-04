"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  getRailLayout,
  saveRailCollapsed,
  saveRailLayout,
} from "@/lib/dashboard-layout-store";
import { loadDashboardData } from "@/lib/dashboard-data";
import { isApproverAnywhere } from "@/lib/approval";
import { WIDGET_IDS, type DashboardWidgetId } from "@/lib/dashboard-layout";
import { parseLayoutPayload, type SaveLayoutResult } from "../dashboard/layout-schema";
import type { DashboardData } from "../dashboard/dashboard-types";

/**
 * 保存当前用户的常驻栏布局（含缩放）。
 * 口径与工作台完全一致：身份只从 session 取，结构与越界校验共用 `parseLayoutPayload`，
 * 最终裁决交给 `normalizeLayoutDoc`（在 store 里）。同样不 revalidate。
 */
export async function saveRailLayoutAction(payload: unknown): Promise<SaveLayoutResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = parseLayoutPayload(payload);
  if (!parsed.ok) return { error: parsed.error };

  await saveRailLayout(session.user.id, parsed.doc);
  return { ok: true };
}

/**
 * 记住常驻栏收起 / 展开：按账号存在 users 表里，换设备登录也按上次的来。
 * 客户端先本地切换、再静默落库；失败不回滚（下次点击再试）。
 */
export async function saveRailCollapsedAction(
  collapsed: unknown,
): Promise<SaveLayoutResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = z.boolean().safeParse(collapsed);
  if (!parsed.success) return { error: "参数无效" };

  await saveRailCollapsed(session.user.id, parsed.data);
  return { ok: true };
}

export type RefreshRailDataResult =
  | { ok: true; data: DashboardData }
  | { error: string };

const typesSchema = z.array(z.enum(WIDGET_IDS)).max(WIDGET_IDS.length * 3);

/**
 * 重新装配常驻栏卡片数据。
 *
 * App Router 的共享 layout 在客户端导航时**不会重新渲染**，常驻栏里的卡片数据
 * （未读数、任务列表等）就会停在首次加载的样子；客户端在路由切换、增删卡片后
 * 调这个 action 主动刷新。
 *
 * `types` 由客户端按当前布局传入（本地还可能有尚未落库的改动）；
 * 缺省时退回读库里的布局。
 */
export async function refreshRailDataAction(types?: unknown): Promise<RefreshRailDataResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  let widgetTypes: DashboardWidgetId[] | undefined;
  if (types !== undefined) {
    const parsed = typesSchema.safeParse(types);
    if (!parsed.success) return { error: "参数无效" };
    widgetTypes = [...new Set(parsed.data)];
  } else {
    const isApprover = await isApproverAnywhere(session.user.id);
    const layout = await getRailLayout(session.user.id, { isApprover });
    widgetTypes = [...new Set(layout.items.map((item) => item.type))];
  }

  return {
    ok: true,
    data: await loadDashboardData(session.user.id, { only: widgetTypes }),
  };
}
