"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  getRightPanelWidth,
  setRightPanelWidth,
  subscribeRightPanelWidth,
} from "./right-panel-width";
import { beginDashboardPaintFreeze } from "./dashboard-paint-freeze";

/**
 * 「右侧浮层挤压正文」的**唯一**一层包装。
 *
 * 挤压宽度存在这里，但**不再通过 React state 驱动**：面板开关时整页子树
 * 有上千个节点，一旦 setState 让 Next/React 重渲染，点击到首帧就要多花几百毫秒。
 * 现在订阅开关/宽度后直接改自己的 class 与 CSS 变量，正文零重渲染，
 * 抽屉 transform 与 padding 过渡在同一帧启动。
 *
 * 挤压是 `padding` 过渡（布局属性，只能主线程逐帧重排）；屏幕外卡片与工作台
 * 首尾帧冻结见 dashboard-paint-freeze.ts，用来减少过渡中间的重排开销。
 */

type PanelKey = "assistant" | "messages";

const openState: Record<PanelKey, boolean> = { assistant: false, messages: false };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((cb) => cb());
}

/** 面板开关同步到这里；同一个值重复上报不触发任何更新 */
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

export function RightPanelPush({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const prevPushedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let freezeCleanup: (() => void) | null = null;

    const clearFreeze = () => {
      freezeCleanup?.();
      freezeCleanup = null;
    };

    const scheduleFreeze = (pushed: boolean) => {
      clearFreeze();
      // 移动端抽屉覆盖，不挤压正文，无需冻结
      if (!window.matchMedia("(min-width: 1024px)").matches) return;
      // 首帧就启动旧快照淡出/新网格淡入；克隆与锁宽已拆到下一帧内部，
      // 这里同步调用本身很轻，点击立刻能看到渐变。
      freezeCleanup = beginDashboardPaintFreeze({
        targetPadding: pushed ? getRightPanelWidth() : 0,
      });
    };

    const apply = () => {
      const pushed = openState.assistant || openState.messages;
      el.style.setProperty("--right-panel-width", `${getRightPanelWidth()}px`);
      el.classList.toggle("assistant-shell-pushed", pushed);
      if (prevPushedRef.current !== pushed) {
        prevPushedRef.current = pushed;
        scheduleFreeze(pushed);
      }
    };

    apply();
    const unsubOpen = subscribe(apply);
    const unsubWidth = subscribeRightPanelWidth(apply);
    // 窗口变窄时把保存的宽度夹回可用范围；拖动中不跑（拖动已按视口夹取）
    const onResize = () => setRightPanelWidth(getRightPanelWidth());
    window.addEventListener("resize", onResize);

    return () => {
      unsubOpen();
      unsubWidth();
      window.removeEventListener("resize", onResize);
      clearFreeze();
    };
  }, []);

  return (
    <div ref={ref} className="assistant-shell-push min-h-screen transition-[padding] duration-300 ease-out">
      {children}
    </div>
  );
}
