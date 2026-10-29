"use client";

import { createContext, useContext } from "react";

/** 消息系统的固定形态：整页 or 右侧浮窗。选定后保持，直到在消息界面右上角显式切换 */
export type MessagesMode = "page" | "drawer";

/**
 * 消息浮窗/模式的 UI 状态。
 *
 * context 单独拆一个中立文件：MessagesPanelShell（浮窗本体，import 了 MessagesClient）
 * 与 MessagesClient、NavLinks（顶栏消息入口）要互相引用，直接 import 会成环，
 * 三方都只依赖这里。
 */
export type MessagesPanelUi = {
  /** 当前固定模式；挂载后从 localStorage 恢复（默认整页） */
  mode: MessagesMode;
  /** 浮窗是否意图打开（仅 drawer 模式下有意义） */
  open: boolean;
  /** 按当前模式打开消息系统：page → 跳整页；drawer → 开浮窗 */
  openMessages: () => void;
  /** drawer 模式下开/关浮窗（page 模式无操作） */
  toggleDrawer: () => void;
  /** 切到另一种模式（消息界面右上角按钮）：page→drawer 或 drawer→page */
  switchMode: () => void;
};

export const MessagesPanelContext = createContext<MessagesPanelUi | null>(null);

export function useMessagesPanel(): MessagesPanelUi | null {
  return useContext(MessagesPanelContext);
}
