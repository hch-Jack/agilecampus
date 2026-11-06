"use client";

import {
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * 「右侧浮层挤压正文」的**唯一**一层包装。
 *
 * 以前 AI 助手与消息浮窗各自在 children 外面包一层 `lg:pr-[570px]`，
 * 而消息浮窗那一层又嵌在助手那一层里面。两个面板互斥、宽度相同，切换时：
 * 外层 0 → 570、内层 570 → 0 同时跑两条 300ms 的 padding 过渡，只要有一帧
 * 起步不同步（effect 在首帧之后才跑到），正文就会先被多挤一下再弹回来——
 * 用户看到的就是「主页面抖一下、闪一下」。
 *
 * 改成两个面板都只向这里报「我开着没有」，宽度由这一个 div 统一决定：
 * 切换时前一个还没关、后一个已经开，`pushed` 始终为 true，正文一动不动。
 * 桌面端挤压、移动端覆盖的口径不变；`assistant-shell-push` 这个类名保留，
 * 宇宙主题的「减弱动态」规则还按它关过渡。
 */

type PanelKey = "assistant" | "messages";

const openState: Record<PanelKey, boolean> = { assistant: false, messages: false };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

/** 面板开关同步到这里；同一个值重复上报不触发渲染 */
export function setRightPanelOpen(panel: PanelKey, open: boolean) {
  if (openState[panel] === open) return;
  openState[panel] = open;
  emit();
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function getSnapshot(): boolean {
  return openState.assistant || openState.messages;
}

/** 服务端与水合首帧：都还没开，不挤压 */
function getServerSnapshot(): boolean {
  return false;
}

export function RightPanelPush({ children }: { children: ReactNode }) {
  const pushed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div
      className={`assistant-shell-push min-h-screen transition-[padding] duration-300 ease-out ${
        pushed ? "lg:pr-[570px]" : ""
      }`}
    >
      {children}
    </div>
  );
}
