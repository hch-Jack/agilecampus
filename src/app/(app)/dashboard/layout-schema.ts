// 布局保存的 zod 信封：工作台与常驻栏共用。
// 不能放在 "use server" 文件里（那个文件只允许导出服务端函数）。
import { z } from "zod";
import {
  CLOCK_MAX_ZONES,
  CLOCK_ZONE_MAX_LENGTH,
  COUNTDOWN_TITLE_MAX_LENGTH,
  GRID_COLUMNS,
  INSTANCE_ID_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  WIDGET_IDS,
  ZOOM_MAX,
  ZOOM_MIN,
  type DashboardLayoutDoc,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";

export type SaveLayoutResult = { ok: true } | { error: string };

/**
 * 卡片数量上限：目录 20 张，可重复卡还能再加一些；留余量给未来版本。
 * （服务端 normalize 会去重、夹取、消解重叠，这里先把明显不像布局的输入挡在门外。）
 */
export const MAX_LAYOUT_ITEMS = 40;

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

export const layoutEnvelopeSchema = z.object({
  v: z.literal(1),
  zoom: z.number().min(ZOOM_MIN).max(ZOOM_MAX).optional(),
  items: z.array(itemSchema).max(MAX_LAYOUT_ITEMS),
});

export type LayoutEnvelope = z.infer<typeof layoutEnvelopeSchema>;

/** 校验通过的信封 → 布局文档（坐标越界交给 normalizeLayoutDoc 裁决） */
export function toLayoutDoc(parsed: LayoutEnvelope): DashboardLayoutDoc {
  return {
    v: 1,
    ...(parsed.zoom !== undefined ? { zoom: parsed.zoom } : {}),
    items: parsed.items.map((item) => ({
      id: item.id,
      type: (item.type ?? item.id) as DashboardWidgetId,
      x: item.x,
      y: item.y,
      w: Math.min(item.w, GRID_COLUMNS),
      h: item.h,
      ...(item.config ? { config: item.config } : {}),
    })),
  };
}

/** 校验 + 组装；两个布局的 server action 都走这里，保证口径一致 */
export function parseLayoutPayload(
  payload: unknown,
): { ok: true; doc: DashboardLayoutDoc } | { ok: false; error: string } {
  const parsed = layoutEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: issue?.message || "布局数据无效" };
  }
  return { ok: true, doc: toLayoutDoc(parsed.data) };
}
