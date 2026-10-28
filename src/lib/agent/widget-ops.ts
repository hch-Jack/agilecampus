import { z } from "zod";
import {
  CLOCK_MAX_ZONES,
  CLOCK_ZONE_MAX_LENGTH,
  COUNTDOWN_TITLE_MAX_LENGTH,
  DASHBOARD_WIDGETS,
  GRID_COLUMNS,
  INSTANCE_ID_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  WIDGET_IDS,
  ZOOM_MAX,
  ZOOM_MIN,
  addWidget,
  addWidgetFullWidth,
  isRepeatableWidgetId,
  moveWidget,
  normalizeZoom,
  removeWidget,
  resizeWidget,
  updateWidgetConfig,
  type DashboardLayoutDoc,
  type DashboardLayoutItem,
  type DashboardWidgetConfig,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import { AppError } from "@/lib/errors";
import { isApproverAnywhere } from "@/lib/approval";
import {
  getDashboardLayout,
  getRailLayout,
  getRailCollapsed,
} from "@/lib/dashboard-layout-store";

/**
 * 助手对「工作台 / 常驻栏卡片」的操作面。
 *
 * 布局文档本身由 `lib/dashboard-layout` 的纯函数维护；本模块只做三件事：
 * 1. 把模型送来的 ops 校验成已知形状（zod）；
 * 2. 在当前布局上按顺序执行，产出**新布局 + 一行行中文摘要**（摘要给确认卡看）；
 * 3. 读取现状给 `list_dashboard_widgets`。
 *
 * 落库永远在 commit.ts 里重做一遍（重读最新布局再执行），这里的结果只用于拟稿预览 ——
 * 与其它写工具同一原则：不信任模型与草案里的任何 id。
 */

export const WIDGET_SURFACES = ["dashboard", "rail"] as const;
export type WidgetSurface = (typeof WIDGET_SURFACES)[number];
export const widgetSurfaceSchema = z.enum(WIDGET_SURFACES);

/** 一份草案里的操作条数上限：再多就该拆成几张卡，确认时也看得清 */
export const WIDGET_OPS_MAX = 20;

/** 卡片配置：与前端设置面板能改的字段一一对应（最终仍由 sanitizeConfig 夹取） */
export const widgetConfigPatchSchema = z
  .object({
    text: z.string().max(NOTE_MAX_LENGTH).optional().describe("便签正文"),
    title: z.string().max(COUNTDOWN_TITLE_MAX_LENGTH).optional().describe("倒计时标题"),
    targetAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "目标时间用 YYYY-MM-DDTHH:mm（用户本地墙面时间）")
      .optional()
      .describe("倒计时目标时间，用户本地墙面时间 YYYY-MM-DDTHH:mm"),
    lunar: z.boolean().optional().describe("时钟：是否显示农历"),
    zones: z
      .array(z.string().max(CLOCK_ZONE_MAX_LENGTH))
      .max(CLOCK_MAX_ZONES)
      .optional()
      .describe("时钟：世界时钟的 IANA 时区，最多 3 个"),
    showGantt: z.boolean().optional().describe("日程表：是否显示甘特"),
    showPool: z.boolean().optional().describe("日程表：是否显示任务池"),
    showCalendar: z.boolean().optional().describe("日程表：是否显示月历"),
    ganttRatio: z.number().min(0).max(1).optional().describe("日程表：甘特占内容区高度的比例"),
    poolRatio: z.number().min(0).max(1).optional().describe("日程表：任务池占正文宽度的比例"),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: "配置为空" });

const instanceIdSchema = z
  .string()
  .min(1)
  .max(INSTANCE_ID_MAX_LENGTH)
  .describe("卡片实例 id，只能取自 list_dashboard_widgets 的 instanceId");

export const widgetOpSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add"),
    type: z.enum(WIDGET_IDS).describe("卡片类型，取自快照「可用卡片类型」"),
    w: z.number().int().min(1).max(GRID_COLUMNS).optional().describe("宽度（格），缺省用目录默认"),
    h: z.number().int().min(1).max(100).optional().describe("高度（格），缺省用目录默认"),
    config: widgetConfigPatchSchema.optional().describe("新卡片的配置（便签正文等）"),
  }),
  z.object({ action: z.literal("remove"), instanceId: instanceIdSchema }),
  z.object({
    action: z.literal("move"),
    instanceId: instanceIdSchema,
    x: z.number().int().min(0).max(GRID_COLUMNS - 1).describe("列（0 起）"),
    y: z.number().int().min(0).describe("行（0 起）"),
  }),
  z.object({
    action: z.literal("resize"),
    instanceId: instanceIdSchema,
    w: z.number().int().min(1).max(GRID_COLUMNS).describe("宽度（格）"),
    h: z.number().int().min(1).max(100).describe("高度（格）"),
  }),
  z.object({
    action: z.literal("update_config"),
    instanceId: instanceIdSchema,
    config: widgetConfigPatchSchema.describe("要改的配置项（增量）"),
  }),
  z.object({
    action: z.literal("set_zoom"),
    zoom: z.number().min(ZOOM_MIN).max(ZOOM_MAX).describe("0.7–1.5，步进 0.1"),
  }),
  z.object({
    action: z.literal("reset"),
    // 卡片上不允许再跟别的 op 时也无妨：reset 之后再执行后续 op 是允许的（先还默认再改）
  }),
]);

export type WidgetOp = z.infer<typeof widgetOpSchema>;

/** 草案信封里除 ops 外的展示字段（摘要、surface）由拟稿时算好，落库只认 surface + ops */
export const widgetOpsDraftSchema = z.object({
  surface: widgetSurfaceSchema,
  ops: z.array(widgetOpSchema).min(1).max(WIDGET_OPS_MAX),
});

/** 可以改配置的卡片：其余卡片的内容来自任务 / 项目等数据，不归布局管 */
const CONFIGURABLE_WIDGETS: readonly DashboardWidgetId[] = [
  "note",
  "clock",
  "countdown",
  "schedule",
];

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** 卡片在摘要里的称呼：便签 / 倒计时带上内容，其余用目录标题 */
export function widgetDisplayName(item: Pick<DashboardLayoutItem, "type" | "config">): string {
  if (item.type === "note") {
    const text = item.config?.text?.trim();
    return text ? `便签「${clip(text, 24)}」` : "便签";
  }
  if (item.type === "countdown") {
    const title = item.config?.title?.trim();
    return title ? `倒计时「${clip(title, 24)}」` : "倒计时";
  }
  return DASHBOARD_WIDGETS[item.type].title;
}

function requireItem(doc: DashboardLayoutDoc, instanceId: string): DashboardLayoutItem {
  const item = doc.items.find((i) => i.id === instanceId);
  if (!item) {
    throw new AppError(
      `没有找到 instanceId=${instanceId} 的卡片；请先调 list_dashboard_widgets 取最新的 id`,
    );
  }
  return item;
}

function requireConfigurable(item: DashboardLayoutItem): void {
  if (!CONFIGURABLE_WIDGETS.includes(item.type)) {
    throw new AppError(
      `「${DASHBOARD_WIDGETS[item.type].title}」没有可调整的设置：它的内容来自任务 / 项目等数据，` +
        "只能改位置、尺寸或删除",
    );
  }
}

function configSummary(type: DashboardWidgetId, patch: DashboardWidgetConfig): string {
  if (type === "note") return `便签内容改为「${clip(patch.text ?? "", 40)}」`;
  if (type === "countdown") {
    const title = patch.title?.trim();
    const target = patch.targetAt?.replace("T", " ");
    return `倒计时${title ? `设为「${clip(title, 24)}」` : "目标时间调整"}${
      target ? `，目标 ${target}` : ""
    }`;
  }
  if (type === "clock") {
    const bits: string[] = [];
    if (patch.lunar !== undefined) bits.push(patch.lunar ? "显示农历" : "不显示农历");
    if (patch.zones !== undefined) {
      bits.push(
        patch.zones.length > 0 ? `世界时钟 ${patch.zones.join("、")}` : "清空世界时钟",
      );
    }
    return `时钟设置：${bits.join("；")}`;
  }
  // schedule
  const bits: string[] = [];
  if (patch.showGantt !== undefined) bits.push(patch.showGantt ? "显示甘特" : "隐藏甘特");
  if (patch.showPool !== undefined) bits.push(patch.showPool ? "显示任务池" : "隐藏任务池");
  if (patch.showCalendar !== undefined)
    bits.push(patch.showCalendar ? "显示月历" : "隐藏月历");
  if (patch.ganttRatio !== undefined) bits.push(`甘特占 ${Math.round(patch.ganttRatio * 100)}%`);
  if (patch.poolRatio !== undefined) bits.push(`任务池占 ${Math.round(patch.poolRatio * 100)}%`);
  return `日程表分区：${bits.join("；")}`;
}

/**
 * 在当前布局上按顺序执行 ops，返回新布局与逐条中文摘要。
 *
 * 任何一条 op 无效（id 不存在、单例卡重复添加、改不可配置的卡片）都**整份**抛错 ——
 * 拟稿阶段就让模型知道错在哪，而不是让用户点确认时才炸。
 */
export function applyWidgetOps(
  doc: DashboardLayoutDoc,
  ops: readonly WidgetOp[],
  opts: { fullWidthAdd: boolean; resetDoc: DashboardLayoutDoc },
): { doc: DashboardLayoutDoc; summary: string[] } {
  let next = doc;
  const summary: string[] = [];

  for (const op of ops) {
    switch (op.action) {
      case "add": {
        const before = new Set(next.items.map((item) => item.id));
        const grown = opts.fullWidthAdd
          ? addWidgetFullWidth(next, op.type)
          : addWidget(next, op.type);
        if (grown.items.length === next.items.length) {
          throw new AppError(
            `「${DASHBOARD_WIDGETS[op.type].title}」已经在布局里了：这类卡片只能有一张` +
              (isRepeatableWidgetId(op.type)
                ? ""
                : "（便签 / 时钟 / 倒计时可以加多张）"),
          );
        }
        next = grown;
        const created = next.items.find((item) => !before.has(item.id));
        if (!created) throw new AppError("新增卡片失败，请重试");

        if (op.w !== undefined || op.h !== undefined) {
          next = resizeWidget(next, created.id, op.w ?? created.w, op.h ?? created.h);
        }
        if (op.config) {
          requireConfigurable(created);
          next = updateWidgetConfig(next, created.id, op.config);
        }
        const finalItem = requireItem(next, created.id);
        summary.push(`新增${widgetDisplayName(finalItem)}（${finalItem.w}×${finalItem.h} 格）`);
        break;
      }
      case "remove": {
        const item = requireItem(next, op.instanceId);
        summary.push(`删除${widgetDisplayName(item)}（${item.w}×${item.h} 格）`);
        next = removeWidget(next, op.instanceId);
        break;
      }
      case "move": {
        const item = requireItem(next, op.instanceId);
        next = moveWidget(next, op.instanceId, op.x, op.y);
        const moved = requireItem(next, op.instanceId);
        summary.push(
          `移动${widgetDisplayName(item)}到第 ${moved.x + 1} 列、第 ${moved.y + 1} 行`,
        );
        break;
      }
      case "resize": {
        const item = requireItem(next, op.instanceId);
        next = resizeWidget(next, op.instanceId, op.w, op.h);
        const resized = requireItem(next, op.instanceId);
        summary.push(`把${widgetDisplayName(item)}改成 ${resized.w}×${resized.h} 格`);
        break;
      }
      case "update_config": {
        const item = requireItem(next, op.instanceId);
        requireConfigurable(item);
        next = updateWidgetConfig(next, op.instanceId, op.config);
        summary.push(configSummary(item.type, op.config));
        break;
      }
      case "set_zoom": {
        const zoom = normalizeZoom(op.zoom);
        next = { v: 1, items: next.items, ...(zoom !== undefined ? { zoom } : {}) };
        summary.push(`网格缩放改为 ${Math.round((zoom ?? 1) * 100)}%`);
        break;
      }
      case "reset": {
        next = opts.resetDoc;
        summary.push("恢复默认布局（自定义卡片与各卡片设置都会清空）");
        break;
      }
    }
  }

  return { doc: next, summary };
}

/** 该 surface 的「恢复默认」布局由调用方按审批人身份给（与页面首屏一致） */
export type WidgetSurfaceView = {
  surface: WidgetSurface;
  zoom: number;
  items: {
    instanceId: string;
    type: DashboardWidgetId;
    title: string;
    x: number;
    y: number;
    w: number;
    h: number;
    config?: DashboardWidgetConfig;
  }[];
};

function viewOf(surface: WidgetSurface, doc: DashboardLayoutDoc): WidgetSurfaceView {
  return {
    surface,
    zoom: doc.zoom ?? 1,
    items: doc.items.map((item) => ({
      instanceId: item.id,
      type: item.type,
      title: DASHBOARD_WIDGETS[item.type].title,
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
      ...(item.config ? { config: item.config } : {}),
    })),
  };
}

/** 读取用户两块网格的现状（含常驻栏是否收起） */
export async function readUserWidgets(actorId: string) {
  const isApprover = await isApproverAnywhere(actorId);
  const [dashboard, rail, collapsed] = await Promise.all([
    getDashboardLayout(actorId, { isApprover }),
    getRailLayout(actorId, { isApprover }),
    getRailCollapsed(actorId),
  ]);
  return {
    dashboard: viewOf("dashboard", dashboard),
    rail: { ...viewOf("rail", rail), collapsed },
  };
}
