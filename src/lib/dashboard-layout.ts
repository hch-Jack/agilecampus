// 工作台自定义布局的纯函数引擎：目录、默认布局、归一化、移动/缩放/增删与压缩。
// 客户端（拖拽预览）与服务端（读库、落库校验）共用，故这里不碰 IO、不 import zod。

export const GRID_COLUMNS = 12;
/**
 * 一行的高度（px），与 dashboard.css 的 grid-auto-rows 保持一致。
 * 取 32 而不是更大的值：统计卡（2 行 = 76px）要贴近改造前 `ac-card p-3` 的高度，
 * 缩放也有更细的档位。
 */
export const GRID_ROW_HEIGHT = 32;
/** 卡片间距（px），指针换算与 CSS gap 共用 */
export const GRID_GAP = 12;

/** 坐标上限，防止坏数据把网格撑到天上去；正常使用远达不到 */
const MAX_Y = 2000;
const MAX_H = 100;

export const NOTE_MAX_LENGTH = 500;
export const COUNTDOWN_TITLE_MAX_LENGTH = 40;

export const WIDGET_IDS = [
  "task_board",
  "task_summary",
  "stat_overdue",
  "stat_today",
  "stat_week",
  "stat_doing",
  "activity_feed",
  "my_projects",
  "upcoming",
  "my_teams",
  "unread_messages",
  "quick_links",
  "note",
  "clock",
  "countdown",
] as const;

export type DashboardWidgetId = (typeof WIDGET_IDS)[number];

/** 四张独立统计卡；与「任务概览（合并）」互斥 */
export const STAT_WIDGET_IDS = [
  "stat_overdue",
  "stat_today",
  "stat_week",
  "stat_doing",
] as const satisfies readonly DashboardWidgetId[];

export type DashboardWidgetConfig = {
  /** 便签正文，≤ NOTE_MAX_LENGTH 字 */
  text?: string;
  /** 倒计时标题，≤ COUNTDOWN_TITLE_MAX_LENGTH 字 */
  title?: string;
  /** 倒计时目标：用户时区的墙面时间 YYYY-MM-DDTHH:mm */
  targetAt?: string;
};

export type DashboardLayoutItem = {
  id: DashboardWidgetId;
  x: number;
  y: number;
  w: number;
  h: number;
  config?: DashboardWidgetConfig;
};

/** 带版本的信封：库中 NULL = 从未自定义；items: [] = 用户主动删空 */
export type DashboardLayoutDoc = { v: 1; items: DashboardLayoutItem[] };

export type DashboardWidgetMeta = {
  id: DashboardWidgetId;
  title: string;
  description: string;
  defaultSize: { w: number; h: number };
  minSize: { w: number; h: number };
};

export const DASHBOARD_WIDGETS: Record<DashboardWidgetId, DashboardWidgetMeta> = {
  task_board: {
    id: "task_board",
    title: "我的任务看板",
    description: "按待办 / 进行中 / 已完成分列，可拖拽换列",
    defaultSize: { w: 8, h: 6 },
    minSize: { w: 6, h: 4 },
  },
  task_summary: {
    id: "task_summary",
    title: "任务概览",
    description: "逾期、今天、本周、进行中四合一",
    defaultSize: { w: 8, h: 2 },
    minSize: { w: 4, h: 2 },
  },
  stat_overdue: {
    id: "stat_overdue",
    title: "逾期",
    description: "已过截止日期且未完成的任务数",
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
  },
  stat_today: {
    id: "stat_today",
    title: "今天截止",
    description: "今天到期且未完成的任务数",
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
  },
  stat_week: {
    id: "stat_week",
    title: "本周截止",
    description: "本周内到期且未完成的任务数",
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
  },
  stat_doing: {
    id: "stat_doing",
    title: "进行中",
    description: "当前进行中的任务数",
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
  },
  activity_feed: {
    id: "activity_feed",
    title: "最新记录",
    description: "分配给你的任务动态与未读提示",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 4, h: 3 },
  },
  my_projects: {
    id: "my_projects",
    title: "我的项目",
    description: "所在团队的项目与完成进度",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  upcoming: {
    id: "upcoming",
    title: "即将到期",
    description: "未完成任务里最近到期的几条",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  my_teams: {
    id: "my_teams",
    title: "我的团队",
    description: "团队角色与内容规模",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  unread_messages: {
    id: "unread_messages",
    title: "消息",
    description: "私信、群聊未读与待处理邀请",
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
  },
  quick_links: {
    id: "quick_links",
    title: "快捷入口",
    description: "项目、团队、消息与 AI 设置",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  note: {
    id: "note",
    title: "便签",
    description: "随手记下的一句话",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  clock: {
    id: "clock",
    title: "时钟",
    description: "按你的时区显示当前时间",
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 2 },
  },
  countdown: {
    id: "countdown",
    title: "倒计时",
    description: "到某个日期时间的倒计时",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 3 },
  },
};

/**
 * 默认布局 = 改造前的页面结构：一行四张统计卡 → 通栏看板 → 通栏最新记录。
 * 高度按 32px 行高换算，贴近原来的 `p-3` 统计瓦片与 `min-h-40` 看板列。
 */
const DEFAULT_ITEMS: DashboardLayoutItem[] = [
  { id: "stat_overdue", x: 0, y: 0, w: 3, h: 2 },
  { id: "stat_today", x: 3, y: 0, w: 3, h: 2 },
  { id: "stat_week", x: 6, y: 0, w: 3, h: 2 },
  { id: "stat_doing", x: 9, y: 0, w: 3, h: 2 },
  { id: "task_board", x: 0, y: 2, w: 12, h: 6 },
  { id: "activity_feed", x: 0, y: 8, w: 12, h: 4 },
];

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutDoc = { v: 1, items: DEFAULT_ITEMS };

function defaultDoc(): DashboardLayoutDoc {
  return { v: 1, items: DEFAULT_ITEMS.map((item) => ({ ...item })) };
}

function isWidgetId(value: unknown): value is DashboardWidgetId {
  return typeof value === "string" && (WIDGET_IDS as readonly string[]).includes(value);
}

function overlap(a: DashboardLayoutItem, b: DashboardLayoutItem): boolean {
  return (
    a.x < b.x + b.w &&
    b.x < a.x + a.w &&
    a.y < b.y + b.h &&
    b.y < a.y + a.h
  );
}

function byPosition(a: DashboardLayoutItem, b: DashboardLayoutItem): number {
  return a.y - b.y || a.x - b.x || a.id.localeCompare(b.id);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** 读入不可信数字：非有限值回落 fallback，其余取整 */
function intOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function sanitizeConfig(
  id: DashboardWidgetId,
  raw: unknown,
): DashboardWidgetConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;

  if (id === "note") {
    return typeof input.text === "string"
      ? { text: input.text.slice(0, NOTE_MAX_LENGTH) }
      : undefined;
  }

  if (id === "countdown") {
    const title =
      typeof input.title === "string" ? input.title.slice(0, COUNTDOWN_TITLE_MAX_LENGTH) : undefined;
    const targetAt =
      typeof input.targetAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.targetAt)
        ? input.targetAt
        : undefined;
    return title === undefined && targetAt === undefined ? undefined : { title, targetAt };
  }

  return undefined;
}

/** 按目录与最小尺寸夹取单个卡片；非法尺寸回落默认值 */
function sanitizeItem(raw: unknown): DashboardLayoutItem | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  if (!isWidgetId(input.id)) return null;

  const meta = DASHBOARD_WIDGETS[input.id];
  const w = clamp(intOr(input.w, meta.defaultSize.w), meta.minSize.w, GRID_COLUMNS);
  const h = clamp(intOr(input.h, meta.defaultSize.h), meta.minSize.h, MAX_H);
  const x = clamp(intOr(input.x, 0), 0, GRID_COLUMNS - w);
  const y = clamp(intOr(input.y, 0), 0, MAX_Y);

  const config = sanitizeConfig(input.id, input.config);
  return config ? { id: input.id, x, y, w, h, config } : { id: input.id, x, y, w, h };
}

/**
 * 按**传入顺序**放置；与已放置卡重叠的循环下移（含级联）。
 *
 * 顺序很重要：拖拽时目标卡排在最前，才能占住用户放下的格子，而不是被同坐标的旧卡挤走。
 */
function resolveOverlaps(items: DashboardLayoutItem[]): DashboardLayoutItem[] {
  const placed: DashboardLayoutItem[] = [];
  for (const item of items) {
    let y = item.y;
    while (placed.some((other) => overlap({ ...item, y }, other))) y += 1;
    placed.push({ ...item, y });
  }
  return placed;
}

/** 向上压缩：按 y,x 顺序，每张卡尽量上移 */
function compact(items: DashboardLayoutItem[]): DashboardLayoutItem[] {
  const placed: DashboardLayoutItem[] = [];
  for (const item of [...items].sort(byPosition)) {
    let y = item.y;
    while (y > 0 && !placed.some((other) => overlap({ ...item, y: y - 1 }, other))) y -= 1;
    placed.push({ ...item, y });
  }
  return placed;
}

function layoutFrom(items: DashboardLayoutItem[]): DashboardLayoutDoc {
  return { v: 1, items: compact(resolveOverlaps(items)) };
}

/** 统计合并卡与四张单项互斥；合并卡优先 */
function applyStatsExclusivity(items: DashboardLayoutItem[]): DashboardLayoutItem[] {
  if (!items.some((item) => item.id === "task_summary")) return items;
  return items.filter((item) => !(STAT_WIDGET_IDS as readonly string[]).includes(item.id));
}

/**
 * 把任意来源（DB JSONB、客户端、坏数据）归一成可信布局。
 *
 * - null / 非 v1 / 结构不对 → 默认布局
 * - 空 items 保留为空（用户主动删光）
 * - 非空但一项都认不出 → 视为脏数据，回落默认
 */
export function normalizeLayoutDoc(raw: unknown): DashboardLayoutDoc {
  if (!raw || typeof raw !== "object") return defaultDoc();
  const input = raw as Record<string, unknown>;
  if (input.v !== 1 || !Array.isArray(input.items)) return defaultDoc();
  if (input.items.length === 0) return { v: 1, items: [] };

  const seen = new Set<DashboardWidgetId>();
  const items: DashboardLayoutItem[] = [];
  for (const rawItem of input.items) {
    const item = sanitizeItem(rawItem);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  if (items.length === 0) return defaultDoc();
  return layoutFrom(applyStatsExclusivity(items).sort(byPosition));
}

/** 移动：从当前文档出发，把目标放到新坐标并重排 */
export function moveWidget(
  doc: DashboardLayoutDoc,
  id: DashboardWidgetId,
  x: number,
  y: number,
): DashboardLayoutDoc {
  const target = doc.items.find((item) => item.id === id);
  if (!target) return doc;

  const moved: DashboardLayoutItem = {
    ...target,
    x: clamp(intOr(x, target.x), 0, GRID_COLUMNS - target.w),
    y: clamp(intOr(y, target.y), 0, MAX_Y),
  };
  const others = doc.items.filter((item) => item.id !== id);
  return layoutFrom([moved, ...others]);
}

/** 缩放：左上角固定，尺寸夹到最小尺寸与 12 列内 */
export function resizeWidget(
  doc: DashboardLayoutDoc,
  id: DashboardWidgetId,
  w: number,
  h: number,
): DashboardLayoutDoc {
  const target = doc.items.find((item) => item.id === id);
  if (!target) return doc;

  const meta = DASHBOARD_WIDGETS[id];
  const nextW = clamp(intOr(w, target.w), meta.minSize.w, GRID_COLUMNS - target.x);
  const nextH = clamp(intOr(h, target.h), meta.minSize.h, MAX_H);
  const resized: DashboardLayoutItem = { ...target, w: nextW, h: nextH };
  const others = doc.items.filter((item) => item.id !== id);
  return layoutFrom([resized, ...others]);
}

/** 添加：已存在则原样返回；追加到现有内容下一行，随后压缩 */
export function addWidget(doc: DashboardLayoutDoc, id: DashboardWidgetId): DashboardLayoutDoc {
  if (doc.items.some((item) => item.id === id)) return doc;

  const kept = applyStatsExclusivity(
    doc.items.filter((item) => {
      if (id === "task_summary") return !(STAT_WIDGET_IDS as readonly string[]).includes(item.id);
      if ((STAT_WIDGET_IDS as readonly string[]).includes(id)) return item.id !== "task_summary";
      return true;
    }),
  );

  const meta = DASHBOARD_WIDGETS[id];
  const bottom = kept.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const added: DashboardLayoutItem = {
    id,
    x: 0,
    y: bottom,
    w: meta.defaultSize.w,
    h: meta.defaultSize.h,
  };
  return layoutFrom([...kept, added]);
}

export function removeWidget(doc: DashboardLayoutDoc, id: DashboardWidgetId): DashboardLayoutDoc {
  if (!doc.items.some((item) => item.id === id)) return doc;
  return layoutFrom(doc.items.filter((item) => item.id !== id));
}

/** 只改配置，不动位置 */
export function updateWidgetConfig(
  doc: DashboardLayoutDoc,
  id: DashboardWidgetId,
  patch: DashboardWidgetConfig,
): DashboardLayoutDoc {
  const target = doc.items.find((item) => item.id === id);
  if (!target) return doc;

  const config = sanitizeConfig(id, { ...target.config, ...patch });
  return {
    v: 1,
    items: doc.items.map((item) => {
      if (item.id !== id) return item;
      if (config) return { ...item, config };
      return { id: item.id, x: item.x, y: item.y, w: item.w, h: item.h };
    }),
  };
}

/** 窄屏 flex 堆叠的阅读顺序：先上后下、先左后右 */
export function widgetOrder(item: Pick<DashboardLayoutItem, "x" | "y">): number {
  return item.y * GRID_COLUMNS + item.x;
}

/** 目录顺序（DOM 顺序固定，避免拖拽时 React 移动节点） */
export function sortByCatalog(doc: DashboardLayoutDoc): DashboardLayoutItem[] {
  const index = new Map<DashboardWidgetId, number>(WIDGET_IDS.map((id, i) => [id, i]));
  return [...doc.items].sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
}
