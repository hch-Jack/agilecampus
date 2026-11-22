"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { beginDashboardPaintFreeze } from "./dashboard-paint-freeze";

/**
 * AI 助手 / 消息共用的一档右侧抽屉宽度。
 *
 * 拖动时**不写 React state**：直接改 `--right-panel-width` 并 rAF 合帧，
 * 抽屉与正文挤压都跟着 CSS 变量实时变宽；松手才提交 state + localStorage。
 * 这样拖动过程不会重渲染整个工作台/消息树。
 */
const STORAGE_KEY = "ac:right-panel-width";
export const RIGHT_PANEL_DEFAULT = 570;
export const RIGHT_PANEL_MIN = 360;
export const RIGHT_PANEL_MAX = 760;

let current = RIGHT_PANEL_DEFAULT;
let hydrated = false;
const listeners = new Set<() => void>();

function clampWidth(px: number): number {
  const viewportMax =
    typeof window === "undefined"
      ? RIGHT_PANEL_MAX
      : Math.max(RIGHT_PANEL_MIN, Math.min(RIGHT_PANEL_MAX, window.innerWidth - 320));
  return Math.round(Math.min(viewportMax, Math.max(RIGHT_PANEL_MIN, px)));
}

function hydrate() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  const saved = Number(window.localStorage.getItem(STORAGE_KEY));
  if (Number.isFinite(saved) && saved > 0) current = clampWidth(saved);
}

function emit() {
  for (const cb of listeners) cb();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** 供挤压层订阅宽度变化（不经过 React state，避免重渲染整页） */
export function subscribeRightPanelWidth(cb: () => void): () => void {
  return subscribe(cb);
}

export function getRightPanelWidth(): number {
  hydrate();
  return current;
}

export function setRightPanelWidth(px: number): void {
  hydrate();
  const next = clampWidth(px);
  if (next !== current) {
    current = next;
    emit();
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // 隐私模式禁用 localStorage 时只影响记忆，不影响拖动
  }
}

/** 拖动中实时写 CSS 变量，不触发 React 渲染；返回夹取后的宽度 */
export function previewRightPanelWidth(px: number): number {
  const next = clampWidth(px);
  if (typeof document !== "undefined") {
    // 必须写在挤压层自身：它 inline 了默认宽度，写在 :root 会被这层覆盖
    const target = document.querySelector<HTMLElement>(".assistant-shell-push");
    (target ?? document.documentElement).style.setProperty(
      "--right-panel-width",
      `${next}px`,
    );
  }
  return next;
}

export function useRightPanelWidth(): number {
  hydrate();
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => RIGHT_PANEL_DEFAULT,
  );
}

/** 抽屉左缘的拖拽把手（桌面端）。键盘左右键也能调宽。 */
export function RightPanelResizeHandle({ label = "侧栏" }: { label?: string }) {
  const width = useRightPanelWidth();
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => cleanupRef.current?.();
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = getRightPanelWidth();
    let latest = startWidth;
    let raf = 0;
    let done = false;

    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.documentElement.dataset.panelResizing = "1";
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    // 拖动也在连续挤压工作台：屏外卡片同样只画首尾
    const endPaintFreeze = beginDashboardPaintFreeze();

    const finish = () => {
      if (done) return;
      done = true;
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      delete document.documentElement.dataset.panelResizing;
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      cleanupRef.current = null;
      endPaintFreeze();
      setRightPanelWidth(latest);
    };

    const onMove = (ev: PointerEvent) => {
      const x = ev.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // 往左拖变宽：宽度 = 起始宽度 + 指针左移距离
        latest = previewRightPanelWidth(startWidth + (startX - x));
      });
    };

    cleanupRef.current = finish;
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home") return;
    e.preventDefault();
    if (e.key === "Home") {
      setRightPanelWidth(RIGHT_PANEL_DEFAULT);
      return;
    }
    setRightPanelWidth(width + (e.key === "ArrowLeft" ? 24 : -24));
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={`拖动调整${label}宽度`}
      aria-valuemin={RIGHT_PANEL_MIN}
      aria-valuemax={RIGHT_PANEL_MAX}
      aria-valuenow={width}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      title="拖动调整宽度（←/→，Home 复位）"
      className="group absolute inset-y-0 left-0 z-30 hidden w-1.5 cursor-col-resize touch-none outline-none lg:block"
    >
      <span className="absolute inset-y-0 left-0 w-px bg-line transition-colors group-hover:bg-primary/60 group-focus-visible:bg-primary" />
      <span className="absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-line opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
    </div>
  );
}
