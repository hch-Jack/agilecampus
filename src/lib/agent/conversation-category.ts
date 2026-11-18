/**
 * AI 助手会话的分类：预设标签 + 关键词自动归类 + 排序规则。
 *
 * 这个模块**不带服务端依赖**：面板（client）要用预设与分组排序，库层要用
 * `classifyConversationText` / `normalizeConversationCategory`。
 *
 * 分类是「轻量、可预期」的：按中文/英文关键词打分，命中最多的一类胜出，平票按
 * 预设顺序；一个都没命中返回 `null`（会话显示为「未分类」）。自动归类只在分类
 * 为空时生效 —— 用户手动的选择永远不被下一轮对话覆盖。
 */

/** 预设分类。顺序即面板里的展示顺序（未分类永远垫底）。 */
export const CONVERSATION_CATEGORY_PRESETS = [
  "项目与任务",
  "消息与沟通",
  "文件与文档",
  "日程与计划",
  "团队与协作",
  "学习与问答",
  "其他",
] as const;

export type ConversationCategoryPreset = (typeof CONVERSATION_CATEGORY_PRESETS)[number];

/** 分类名长度上限（码点）：一行徽标放得下，也不给库列塞长文本 */
export const CONVERSATION_CATEGORY_MAX = 20;

export const UNCATEGORIZED_LABEL = "未分类";

/**
 * 关键词表。中英混排：英文按小写匹配（调用方先把文本转小写）。
 * 词不能太泛（如「做」「看」），否则几乎每条都命中。
 */
const CATEGORY_KEYWORDS: Record<ConversationCategoryPreset, readonly string[]> = {
  项目与任务: [
    "任务",
    "项目",
    "进度",
    "里程碑",
    "子任务",
    "待办",
    "看板",
    "优先级",
    "指派",
    "拆解",
    "完成情况",
    "task",
    "project",
    "milestone",
  ],
  消息与沟通: [
    "消息",
    "私信",
    "群聊",
    "聊天",
    "通知",
    "联系人",
    "转发",
    "回复",
    "发消息",
    "私聊",
    "message",
    "chat",
    "dm",
  ],
  文件与文档: [
    "文件",
    "附件",
    "文档",
    "表格",
    "导出",
    "生成",
    "下载",
    "上传",
    "报告",
    "资料",
    "excel",
    "xlsx",
    "csv",
    "word",
    "docx",
    "pdf",
    "ppt",
  ],
  日程与计划: [
    "日程",
    "计划",
    "排期",
    "截止",
    "提醒",
    "日历",
    "今天",
    "明天",
    "后天",
    "本周",
    "下周",
    "安排",
    "会议",
    "时间",
    "日期",
    "schedule",
    "deadline",
    "calendar",
  ],
  团队与协作: [
    "团队",
    "成员",
    "审批",
    "资源",
    "标签",
    "邀请",
    "管理员",
    "老师",
    "同学",
    "组员",
    "结题",
    "验收",
    "team",
    "member",
    "approval",
  ],
  学习与问答: [
    "学习",
    "复习",
    "解释",
    "概念",
    "为什么",
    "如何",
    "教程",
    "考试",
    "作业",
    "论文",
    "原理",
    "区别",
    "怎么",
    "learn",
    "explain",
  ],
  其他: [],
};

/** 去掉多余空白与控制字符，按码点截到上限；空串 → null */
export function normalizeConversationCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // 控制字符（含换行/制表）换成空格再折叠 —— 直接删掉会让前后两截粘成一个词
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length > CONVERSATION_CATEGORY_MAX
    ? chars.slice(0, CONVERSATION_CATEGORY_MAX).join("")
    : cleaned;
}

/**
 * 按关键词给一段文本归类；一个都没命中返回 null（留给「未分类」），
 * 不在代码里硬塞「其他」——自动判定说不清时，沉默比瞎猜好。
 */
export function classifyConversationText(text: string): string | null {
  const body = text.toLowerCase();
  if (!body.trim()) return null;

  let best: ConversationCategoryPreset | null = null;
  let bestScore = 0;
  for (const category of CONVERSATION_CATEGORY_PRESETS) {
    let score = 0;
    for (const keyword of CATEGORY_KEYWORDS[category]) {
      if (body.includes(keyword)) score += 1;
    }
    // 平票保留先出现的预设：顺序即偏好，别让后遍历的分类莫名胜出
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return best;
}

/** 分组排序：预设按声明顺序，自定义分类按名称，未分类垫底 */
export function compareConversationCategories(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const ia = CONVERSATION_CATEGORY_PRESETS.indexOf(a as ConversationCategoryPreset);
  const ib = CONVERSATION_CATEGORY_PRESETS.indexOf(b as ConversationCategoryPreset);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b, "zh-Hans-CN");
}

export function categoryLabel(category: string | null): string {
  return category ?? UNCATEGORIZED_LABEL;
}
