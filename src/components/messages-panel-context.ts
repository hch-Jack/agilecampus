"use client";

import { createContext, useContext } from "react";

/**
 * 消息浮窗的 UI 状态。
 *
 * context 单独拆一个中立文件：MessagesPanelShell（浮窗本体，import 了 MessagesClient）
 * 与 MessagesClient（消息页/浮窗内容）要互相引用，直接 import 会成环，
 * 双方都只依赖这里。
 */
export type MessagesPanelUi = {
  /** 浮窗当前是否意图打开（路由在 /messages 上时浮窗会让位给整页，见 MessagesPanelShell） */
  open: boolean;
  /** 整页 → 浮窗：打开浮窗并离开消息页（回到进消息页前的页面，兜底工作台） */
  openAndLeave: () => void;
  /** 浮窗 → 整页：收起浮窗并打开整页消息 */
  expandToPage: () => void;
};

export const MessagesPanelContext = createContext<MessagesPanelUi | null>(null);

export function useMessagesPanel(): MessagesPanelUi | null {
  return useContext(MessagesPanelContext);
}
