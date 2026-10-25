// 工作台自定义布局的纯函数引擎：目录、默认布局、归一化、移动/缩放/增删与碰撞消解。
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
/** 实例 id 长度上限（与 server action 的 zod 校验一致） */
export const INSTANCE_ID_MAX_LENGTH = 64;

export const NOTE_MAX_LENGTH = 500;
export const COUNTDOWN_TITLE_MAX_LENGTH = 40;
export const CLOCK_MAX_ZONES = 3;
export const CLOCK_ZONE_MAX_LENGTH = 64;

/** 日程表：甘特占内容区的比例范围（分区拖拽可调） */
export const SCHEDULE_GANTT_RATIO_MIN = 0.15;
export const SCHEDULE_GANTT_RATIO_MAX = 0.7;
/** 日程表：宽卡时任务池占正文宽度的比例范围 */
export const SCHEDULE_POOL_RATIO_MIN = 0.2;
export const SCHEDULE_POOL_RATIO_MAX = 0.5;

export const WIDGET_IDS = [
  "task_board",
  "schedule",
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
  "milestones",
  "resource_usage",
  "recent_attachments",
  "approvals",
  "focus_timer",
  "note",
  "clock",
  "countdown",
] as const;

export type DashboardWidgetId = (typeof WIDGET_IDS)[number];

/** 四张独立统计卡 */
export const STAT_WIDGET_IDS = [
  "stat_overdue",
  "stat_today",
  "stat_week",
  "stat_doing",
] as const satisfies readonly DashboardWidgetId[];

/**
 * 可以重复添加的卡片：每个实例有自己的 id 与配置（便签、时钟、倒计时）。
 * 其余卡片全页只允许一张 —— 否则同一份数据铺满页面，既冗余又难用。
 */
export const REPEATABLE_WIDGET_IDS = [
  "note",
  "clock",
  "countdown",
] as const satisfies readonly DashboardWidgetId[];

export function isRepeatableWidgetId(type: DashboardWidgetId): boolean {
  return (REPEATABLE_WIDGET_IDS as readonly string[]).includes(type);
}

export type DashboardWidgetConfig = {
  /** 便签正文，≤ NOTE_MAX_LENGTH 字 */
  text?: string;
  /** 倒计时标题，≤ COUNTDOWN_TITLE_MAX_LENGTH 字 */
  title?: string;
  /** 倒计时目标：用户时区的墙面时间 YYYY-MM-DDTHH:mm */
  targetAt?: string;
  /** 时钟：显示农历 */
  lunar?: boolean;
  /** 时钟：世界时钟的 IANA 时区（最多 CLOCK_MAX_ZONES 个） */
  zones?: string[];
  /** 日程表：是否显示甘特 / 任务池 / 月历（缺省 = 显示） */
  showGantt?: boolean;
  showPool?: boolean;
  showCalendar?: boolean;
  /** 日程表：甘特占内容区高度的比例 */
  ganttRatio?: number;
  /** 日程表：宽卡时任务池占正文宽度的比例 */
  poolRatio?: number;
};

/**
 * 网格里的一项。
 *
 * `type` 决定渲染哪种卡片；`id` 是**实例 id**（唯一，React key 与拖拽定位都用它）。
 * 单例卡片的实例 id 约定为类型名（如 "task_board"），可重复卡片从第二个起为
 * `note-2`、`clock-2` 之类。旧版布局没有 `type` 字段，读入时按 `id` 回填类型。
 */
export type DashboardLayoutItem = {
  id: string;
  type: DashboardWidgetId;
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
  schedule: {
    id: "schedule",
    title: "日程表",
    description: "甘特 + 任务池 + 月历，可拖动分区、按需隐藏",
    // 默认 8×9：甘特、任务池、月历三段同屏，任务池还能展开成左侧竖栏
    defaultSize: { w: 8, h: 9 },
    minSize: { w: 6, h: 6 },
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
  milestones: {
    id: "milestones",
    title: "项目里程碑",
    description: "所在项目里最近要到的里程碑",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  resource_usage: {
    id: "resource_usage",
    title: "团队资源占用",
    description: "团队共享资源的占用中与最近记录",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  recent_attachments: {
    id: "recent_attachments",
    title: "最近附件",
    description: "所在项目最近上传的任务附件",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  approvals: {
    id: "approvals",
    title: "待办审批",
    description: "老师/管理员处理学生的任务完成与资源占用申请",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  focus_timer: {
    id: "focus_timer",
    title: "专注计时",
    description: "25 分钟专注 / 5 分钟休息的番茄钟",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  note: {
    id: "note",
    title: "便签",
    description: "随手记下的一句话，可添加多张",
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 },
  },
  clock: {
    id: "clock",
    title: "时钟",
    description: "本地时间，可显示农历与世界时钟，可添加多个",
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  countdown: {
    id: "countdown",
    title: "倒计时",
    description: "到某个日期时间的倒计时，可添加多个",
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 3 },
  },
};

/**
 * 默认布局：所有卡片都放出来，按「高频 → 辅助」从上到下铺满 12 列。
 *
 * 版式（共 23 行）：
 *   y0-1   四张统计卡
 *   y2-7   看板（8 列）+ 最新记录 / 消息（右 4 列）
 *   y8-16  日程表（8 列 × 9 行）+ 我的项目 / 时钟 / 快捷入口（右 4 列）
 *   y17-19 一排 3 列辅助卡（即将到期、里程碑、资源、附件）
 *   y20-22 一排 3 列辅助卡（团队、便签、倒计时、专注）
 *
 * 时钟与快捷入口从页尾提到日程表右侧：这两张是小工具，常用的不该压在最底下。
 * 辅助卡统一压到 3 列 × 3 行（约 240×120），两排就装完，整页高度反而比之前更短。
 */
const DEFAULT_ITEMS: DashboardLayoutItem[] = [
  { id: "stat_overdue", type: "stat_overdue", x: 0, y: 0, w: 3, h: 2 },
  { id: "stat_today", type: "stat_today", x: 3, y: 0, w: 3, h: 2 },
  { id: "stat_week", type: "stat_week", x: 6, y: 0, w: 3, h: 2 },
  { id: "stat_doing", type: "stat_doing", x: 9, y: 0, w: 3, h: 2 },
  { id: "task_board", type: "task_board", x: 0, y: 2, w: 8, h: 6 },
  { id: "activity_feed", type: "activity_feed", x: 8, y: 2, w: 4, h: 4 },
  { id: "unread_messages", type: "unread_messages", x: 8, y: 6, w: 4, h: 2 },
  { id: "schedule", type: "schedule", x: 0, y: 8, w: 8, h: 9 },
  { id: "my_projects", type: "my_projects", x: 8, y: 8, w: 4, h: 3 },
  { id: "clock", type: "clock", x: 8, y: 11, w: 4, h: 3 },
  { id: "quick_links", type: "quick_links", x: 8, y: 14, w: 4, h: 3 },
  { id: "upcoming", type: "upcoming", x: 0, y: 17, w: 3, h: 3 },
  { id: "milestones", type: "milestones", x: 3, y: 17, w: 3, h: 3 },
  { id: "resource_usage", type: "resource_usage", x: 6, y: 17, w: 3, h: 3 },
  { id: "recent_attachments", type: "recent_attachments", x: 9, y: 17, w: 3, h: 3 },
  { id: "my_teams", type: "my_teams", x: 0, y: 20, w: 3, h: 3 },
  { id: "note", type: "note", x: 3, y: 20, w: 3, h: 3 },
  { id: "countdown", type: "countdown", x: 6, y: 20, w: 3, h: 3 },
  { id: "focus_timer", type: "focus_timer", x: 9, y: 20, w: 3, h: 3 },
];

export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayoutDoc = { v: 1, items: DEFAULT_ITEMS };

/**
 * 老师/管理员的默认布局：在通用默认之上追加「待办审批」卡（放在动态流下方）。
 * 只有从未自定义过布局的审批人首次进入时用一次，自定义后完全以库中为准。
 */
export function defaultDashboardLayoutFor(isApprover: boolean): DashboardLayoutDoc {
  if (!isApprover) return DEFAULT_DASHBOARD_LAYOUT;
  return {
    v: 1,
    items: [
      ...DEFAULT_ITEMS,
      // 通用默认的最后一行在 y=20；审批卡另起一行，避免与日程表等新卡重叠
      { id: "approvals", type: "approvals", x: 0, y: 23, w: 4, h: 4 },
    ],
  };
}

function defaultDoc(): DashboardLayoutDoc {
  return { v: 1, items: DEFAULT_ITEMS.map((item) => ({ ...item })) };
}

function isWidgetId(value: unknown): value is DashboardWidgetId {
  return typeof value === "string" && (WIDGET_IDS as readonly string[]).includes(value);
}

/** IANA 时区名只做字符集校验；是否真的被运行时支持由渲染侧 try/catch 兜底 */
function isTimeZoneName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CLOCK_ZONE_MAX_LENGTH &&
    /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)
  );
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
  type: DashboardWidgetId,
  raw: unknown,
): DashboardWidgetConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const input = raw as Record<string, unknown>;

  if (type === "note") {
    return typeof input.text === "string"
      ? { text: input.text.slice(0, NOTE_MAX_LENGTH) }
      : undefined;
  }

  if (type === "clock") {
    const config: DashboardWidgetConfig = {};
    if (typeof input.lunar === "boolean") config.lunar = input.lunar;
    if (Array.isArray(input.zones)) {
      // 去重保序，最多 CLOCK_MAX_ZONES 个；空数组也要保留 —— 用户可能刚把世界时钟全删掉
      config.zones = [
        ...new Set(input.zones.filter(isTimeZoneName)),
      ].slice(0, CLOCK_MAX_ZONES);
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  if (type === "countdown") {
    const title =
      typeof input.title === "string" ? input.title.slice(0, COUNTDOWN_TITLE_MAX_LENGTH) : undefined;
    const targetAt =
      typeof input.targetAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input.targetAt)
        ? input.targetAt
        : undefined;
    return title === undefined && targetAt === undefined ? undefined : { title, targetAt };
  }

  if (type === "schedule") {
    const config: DashboardWidgetConfig = {};
    if (typeof input.showGantt === "boolean") config.showGantt = input.showGantt;
    if (typeof input.showPool === "boolean") config.showPool = input.showPool;
    if (typeof input.showCalendar === "boolean") config.showCalendar = input.showCalendar;
    if (typeof input.ganttRatio === "number" && Number.isFinite(input.ganttRatio)) {
      // 比例留 3 位小数：拖拽时前端也只发这个精度
      config.ganttRatio = Math.round(
        clamp(input.ganttRatio, SCHEDULE_GANTT_RATIO_MIN, SCHEDULE_GANTT_RATIO_MAX) * 1000,
      ) / 1000;
    }
    if (typeof input.poolRatio === "number" && Number.isFinite(input.poolRatio)) {
      config.poolRatio = Math.round(
        clamp(input.poolRatio, SCHEDULE_POOL_RATIO_MIN, SCHEDULE_POOL_RATIO_MAX) * 1000,
      ) / 1000;
    }
    return Object.keys(config).length > 0 ? config : undefined;
  }

  return undefined;
}

/** 实例 id：旧文档里 id 就是类型名；新文档里是 `note-2` 这样的独立标识 */
function sanitizeInstanceId(raw: unknown, type: DashboardWidgetId): string {
  if (typeof raw === "string") {
    const id = raw.trim();
    if (id.length > 0 && id.length <= INSTANCE_ID_MAX_LENGTH) return id;
  }
  return type;
}

/** 按目录与最小尺寸夹取单个卡片；非法尺寸回落默认值 */
function sanitizeItem(raw: unknown): DashboardLayoutItem | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;

  // 兼容旧版布局（只有 id、没有 type）：此时 id 就是卡片类型
  const type = isWidgetId(input.type) ? input.type : isWidgetId(input.id) ? input.id : null;
  if (!type) return null;

  const meta = DASHBOARD_WIDGETS[type];
  const w = clamp(intOr(input.w, meta.defaultSize.w), meta.minSize.w, GRID_COLUMNS);
  const h = clamp(intOr(input.h, meta.defaultSize.h), meta.minSize.h, MAX_H);
  const x = clamp(intOr(input.x, 0), 0, GRID_COLUMNS - w);
  const y = clamp(intOr(input.y, 0), 0, MAX_Y);

  const id = sanitizeInstanceId(input.id, type);
  const config = sanitizeConfig(type, input.config);
  return config ? { id, type, x, y, w, h, config } : { id, type, x, y, w, h };
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

/**
 * 布局规则是**自由留白**：只消解重叠，不自动回填空隙。
 * 用户把卡片拖到下方、或在两张卡之间留白，位置就按放下时算；
 * 删卡也不牵动其他卡片（想收拢就手动拖，或「恢复默认」）。
 */
function layoutFrom(items: DashboardLayoutItem[]): DashboardLayoutDoc {
  return { v: 1, items: resolveOverlaps(items) };
}

/**
 * 把任意来源（DB JSONB、客户端、坏数据）归一成可信布局。
 *
 * - null / 非 v1 / 结构不对 → 默认布局
 * - 空 items 保留为空（用户主动删光）
 * - 非空但一项都认不出 → 视为脏数据，回落默认
 * - 未知类型丢弃；单例卡同类型只留第一张；实例 id 重复只留第一份
 * - 坐标原样保留（允许留白），只把重叠项向下推开
 */
export function normalizeLayoutDoc(raw: unknown): DashboardLayoutDoc {
  if (!raw || typeof raw !== "object") return defaultDoc();
  const input = raw as Record<string, unknown>;
  if (input.v !== 1 || !Array.isArray(input.items)) return defaultDoc();
  if (input.items.length === 0) return { v: 1, items: [] };

  const seenIds = new Set<string>();
  const seenTypes = new Set<DashboardWidgetId>();
  const items: DashboardLayoutItem[] = [];
  for (const rawItem of input.items) {
    const item = sanitizeItem(rawItem);
    if (!item || seenIds.has(item.id)) continue;
    if (!isRepeatableWidgetId(item.type)) {
      if (seenTypes.has(item.type)) continue;
      seenTypes.add(item.type);
    }
    seenIds.add(item.id);
    items.push(item);
  }

  if (items.length === 0) return defaultDoc();
  return layoutFrom(items.sort(byPosition));
}

/** 移动：从当前文档出发，把目标放到新坐标并重排 */
export function moveWidget(
  doc: DashboardLayoutDoc,
  id: string,
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
  id: string,
  w: number,
  h: number,
): DashboardLayoutDoc {
  const target = doc.items.find((item) => item.id === id);
  if (!target) return doc;

  const meta = DASHBOARD_WIDGETS[target.type];
  const nextW = clamp(intOr(w, target.w), meta.minSize.w, GRID_COLUMNS - target.x);
  const nextH = clamp(intOr(h, target.h), meta.minSize.h, MAX_H);
  const resized: DashboardLayoutItem = { ...target, w: nextW, h: nextH };
  const others = doc.items.filter((item) => item.id !== id);
  return layoutFrom([resized, ...others]);
}

/** 新实例 id：首个实例沿用类型名，之后依次 `type-2`、`type-3` */
function nextInstanceId(doc: DashboardLayoutDoc, type: DashboardWidgetId): string {
  const used = new Set(doc.items.map((item) => item.id));
  if (!used.has(type)) return type;
  let n = 2;
  while (used.has(`${type}-${n}`)) n += 1;
  return `${type}-${n}`;
}

/** 添加：单例卡已存在则原样返回；可重复卡每次新增一个实例，追加到内容下方 */
export function addWidget(doc: DashboardLayoutDoc, type: DashboardWidgetId): DashboardLayoutDoc {
  if (!isRepeatableWidgetId(type) && doc.items.some((item) => item.type === type)) return doc;

  const meta = DASHBOARD_WIDGETS[type];
  const bottom = doc.items.reduce((max, item) => Math.max(max, item.y + item.h), 0);
  const added: DashboardLayoutItem = {
    id: nextInstanceId(doc, type),
    type,
    x: 0,
    y: bottom,
    w: meta.defaultSize.w,
    h: meta.defaultSize.h,
  };
  return layoutFrom([...doc.items, added]);
}

/** 按实例 id 删除（可重复卡只删掉这一张） */
export function removeWidget(doc: DashboardLayoutDoc, id: string): DashboardLayoutDoc {
  if (!doc.items.some((item) => item.id === id)) return doc;
  return layoutFrom(doc.items.filter((item) => item.id !== id));
}

/** 只改配置，不动位置（按实例 id 定位，同一类型的多张卡互不影响） */
export function updateWidgetConfig(
  doc: DashboardLayoutDoc,
  id: string,
  patch: DashboardWidgetConfig,
): DashboardLayoutDoc {
  const target = doc.items.find((item) => item.id === id);
  if (!target) return doc;

  const config = sanitizeConfig(target.type, { ...target.config, ...patch });
  return {
    v: 1,
    items: doc.items.map((item) => {
      if (item.id !== id) return item;
      if (config) return { ...item, config };
      return { id: item.id, type: item.type, x: item.x, y: item.y, w: item.w, h: item.h };
    }),
  };
}

/** 窄屏 flex 堆叠的阅读顺序：先上后下、先左后右 */
export function widgetOrder(item: Pick<DashboardLayoutItem, "x" | "y">): number {
  return item.y * GRID_COLUMNS + item.x;
}

/**
 * 目录顺序（DOM 顺序固定，避免拖拽时 React 移动节点）。
 * 同类型多实例按实例 id 排序，保证每次渲染顺序稳定。
 */
export function sortByCatalog(doc: DashboardLayoutDoc): DashboardLayoutItem[] {
  const index = new Map<DashboardWidgetId, number>(WIDGET_IDS.map((id, i) => [id, i]));
  return [...doc.items].sort(
    (a, b) => (index.get(a.type) ?? 0) - (index.get(b.type) ?? 0) || a.id.localeCompare(b.id),
  );
}
