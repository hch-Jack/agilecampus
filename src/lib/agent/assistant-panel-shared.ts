/**
 * 右侧助手面板的客户端安全常量与类型。
 *
 * 这个文件**不能** import 任何服务端模块（db、auth、conversation.ts 等）：
 * `assistant-shell.tsx` 与设置页的客户端组件都要用它，带进 db 依赖会把整条服务端图拖进浏览器包。
 * 服务端返回的 Date 一律在这里的边界上转成 ISO 字符串。
 */

import { MAX_FILE_SIZE } from "@/lib/file-limits";

/** 记住「上次看的是哪条会话」；只是 UX 提示，服务端仍会校验归属 */
export const ASSISTANT_CONVERSATION_COOKIE = "ac_assistant_conversation";
export const ASSISTANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** 设置页清空历史后广播给常驻面板（面板在 layout 里，不会随之刷新） */
export const ASSISTANT_RESET_EVENT = "ac:assistant-reset";

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  /** 分类标签；null = 未分类（面板按分类分桶展示） */
  category: string | null;
  createdAt: string; // ISO
  lastMessageAt: string | null; // ISO
};

/**
 * 用户随一句话上传的文件（存库时是 `messages.attachments` 的 jsonb 快照）。
 * `id` 指向 `agent_files` 行，下载走 `/api/assistant/files/[id]`（仅上传者本人可读）。
 * 文件名/类型/大小内联保存 —— 源文件被清理后，聊天记录里仍能显示它当时叫什么。
 */
export type MessageAttachment = {
  id: string;
  filename: string;
  mimeType: string | null;
  size: number;
};

export type AssistantPanelMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments?: MessageAttachment[];
  /** 本人给这条消息打的标签（只对助手消息有意义；服务端已按用户过滤） */
  tags?: string[];
  /** 这一轮助手生成 / 打开过的文件（从工具轨迹还原，刷新后仍可下载） */
  files?: AssistantFile[];
};

/** 一句话最多带几个文件；单文件上限与任务附件一致（1GB），在服务端也再校一次 */
export const ASSISTANT_ATTACHMENTS_MAX = 5;
export const ASSISTANT_FILE_MAX_SIZE = MAX_FILE_SIZE;

/** 助手拟「打开某页」时随响应下发的跳转意图；面板据此自动跳转并留一个可点的入口 */
export type AssistantNavigation = { label: string; href: string };

/**
 * 「我生成过的文件」列表项：跨会话从助手消息的工具轨迹还原（只取 create_file 的结果）。
 * `url` 是下载/预览路由，会话与消息 id 用来把用户带回当时那条答复。
 */
export type GeneratedFileEntry = {
  url: string;
  filename: string;
  mimeType: string | null;
  size: number;
  conversationId: string;
  conversationTitle: string | null;
  messageId: string;
  createdAt: string; // ISO
};

/** 助手拟「打开某文件」时随响应下发的预览目标；面板据此弹出预览并留一个可点的入口 */
export type AssistantFile = {
  url: string;
  filename: string;
  mimeType: string | null;
  size: number;
  /** 收到后是否自动弹预览；create_file 生成的文件为 false（给文件卡，不抢屏） */
  autoOpen?: boolean;
};
