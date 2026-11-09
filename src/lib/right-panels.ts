/**
 * 右侧浮层（AI 助手面板 / 消息浮窗）之间的互斥广播。
 *
 * 两个面板都常驻 layout、各自持有 open 状态，互相不 import（避免循环依赖），
 * 靠 window 事件通知「我开了，你收起来」——与 ASSISTANT_RESET_EVENT 同一套路。
 * 只在 open 变 true 时广播：关闭不发事件，天然不会来回触发死循环。
 */

/** 消息浮窗打开 → AI 助手面板收起 */
export const MESSAGES_PANEL_OPEN_EVENT = "ac:messages-panel-open";

/** AI 助手面板打开 → 消息浮窗收起 */
export const ASSISTANT_PANEL_OPEN_EVENT = "ac:assistant-panel-open";

/**
 * 从页面里「带着一句话」唤起 AI 助手：助手面板打开，这句话作为一条助手提示出现在
 * 对话里（**不代发**，用户看完自己写要求再发送）——日程表的「AI 排期」按钮用它。
 */
export const ASSISTANT_PROMPT_EVENT = "ac:assistant-prompt";

export type AssistantPromptDetail = { text: string };

/** 唤起助手并在对话里显示一条提示（不依赖助手面板的实现细节，靠 window 事件解耦）。 */
export function openAssistantWithPrompt(text: string) {
  if (typeof window === "undefined") return;
  const detail: AssistantPromptDetail = { text };
  window.dispatchEvent(new CustomEvent<AssistantPromptDetail>(ASSISTANT_PROMPT_EVENT, { detail }));
}
