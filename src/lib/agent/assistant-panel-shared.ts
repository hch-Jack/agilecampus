/**
 * 右侧助手面板的客户端安全常量与类型。
 *
 * 这个文件**不能** import 任何服务端模块（db、auth、conversation.ts 等）：
 * `assistant-shell.tsx` 与设置页的客户端组件都要用它，带进 db 依赖会把整条服务端图拖进浏览器包。
 * 服务端返回的 Date 一律在这里的边界上转成 ISO 字符串。
 */

/** 记住「上次看的是哪条会话」；只是 UX 提示，服务端仍会校验归属 */
export const ASSISTANT_CONVERSATION_COOKIE = "ac_assistant_conversation";
export const ASSISTANT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** 设置页清空历史后广播给常驻面板（面板在 layout 里，不会随之刷新） */
export const ASSISTANT_RESET_EVENT = "ac:assistant-reset";

export type AssistantConversationSummary = {
  id: string;
  title: string | null;
  createdAt: string; // ISO
  lastMessageAt: string | null; // ISO
};

export type AssistantPanelMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

/** 助手拟「打开某页」时随响应下发的跳转意图；面板据此自动跳转并留一个可点的入口 */
export type AssistantNavigation = { label: string; href: string };
