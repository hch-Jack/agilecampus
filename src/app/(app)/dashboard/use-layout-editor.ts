"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  addWidget,
  addWidgetFullWidth,
  gridMetrics,
  moveWidget,
  normalizeZoom,
  removeWidget,
  resizeWidget,
  updateWidgetConfig,
  type DashboardLayoutDoc,
  type DashboardWidgetConfig,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import { useGridInteraction } from "./use-grid-interaction";
import type { ConfigChange } from "./widgets/personal";
import {
  isLayoutSavedDetail,
  LAYOUT_SAVED_EVENT,
} from "@/lib/dashboard-layout-events";

export type LayoutSaveState = "idle" | "saving" | "saved" | "error";
type SaveResult = { ok: true } | { error: string };

/**
 * 自定义网格的状态机：布局 / FLIP 动画 / 串行保存 / 拖拽接线 / 增删改。
 * 工作台与常驻栏各实例化一份，保存目标由 `save` 注入。
 */
export function useLayoutEditor({
  initialLayout,
  save,
  getResetLayout,
  addFullWidth = false,
  getScrollContainer,
  surface,
}: {
  initialLayout: DashboardLayoutDoc;
  /** 这块网格对应哪一份用户布局：助手落库后按它判断「这条广播是不是给我的」 */
  surface: "dashboard" | "rail";
  /** 落库动作（工作台 / 常驻栏各自的 server action） */
  save: (doc: DashboardLayoutDoc) => Promise<SaveResult>;
  /** 「恢复默认」产出的布局（审批人与常驻栏各有变体） */
  getResetLayout: () => DashboardLayoutDoc;
  /** 新卡是否默认拉满整行（常驻栏较窄，满宽更好看） */
  addFullWidth?: boolean;
  /** 拖拽边缘自动滚动的容器；缺省为整页 */
  getScrollContainer?: () => HTMLElement | null;
}) {
  // 只在挂载时播种一次：之后 router.refresh / 筛选导航带回的 props 不得覆盖本地未保存布局
  const [layout, setLayout] = useState<DashboardLayoutDoc>(initialLayout);
  const layoutRef = useRef(layout);
  const [saveState, setSaveState] = useState<LayoutSaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<DashboardLayoutDoc | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  /**
   * FLIP 过渡：CSS 里 grid-row / grid-column 没法做动画（Chromium 不插值），
   * 所以在每次布局更新前记下每张卡相对网格的视觉位置，渲染后先把卡片「拉回」旧位置，
   * 再动画归位 —— 被拖动 / 缩放的那张卡自己不做动画，否则会落后于指针。
   * 用相对网格的坐标，避免拖拽时页面向下自动滚动把位移算进动画里。
   */
  const prevRects = useRef(new Map<string, { x: number; y: number }>());

  function measureRelativeToGrid(): Map<string, { x: number; y: number }> {
    const rects = new Map<string, { x: number; y: number }>();
    const grid = gridRef.current;
    if (!grid) return rects;
    const gridRect = grid.getBoundingClientRect();
    grid.querySelectorAll<HTMLElement>("[data-widget-id]").forEach((node) => {
      const id = node.dataset.widgetId;
      if (!id) return;
      const rect = node.getBoundingClientRect();
      rects.set(id, { x: rect.left - gridRect.left, y: rect.top - gridRect.top });
    });
    return rects;
  }

  function applyLayout(next: DashboardLayoutDoc) {
    prevRects.current = measureRelativeToGrid();
    layoutRef.current = next;
    // 每次都换一个信封引用：取消拖动时传入的可能是同一个 snapshot，
    // 若 React 判定状态未变而跳过渲染，卡片的亚格子位移就没人收尾了
    setLayout({ v: next.v, items: next.items, ...(next.zoom !== undefined ? { zoom: next.zoom } : {}) });
  }

  useLayoutEffect(() => {
    const before = prevRects.current;
    prevRects.current = new Map();
    const grid = gridRef.current;
    if (!grid || before.size === 0) return;

    const nodes = grid.querySelectorAll<HTMLElement>("[data-widget-id]");
    // 先清掉上一轮仍在飞的过渡，否则量到的是动画中途的位置；
    // 同时收掉拖动留下的亚格子 transform（拖动中的那张卡除外，它还要继续跟手）
    nodes.forEach((node) => {
      node.getAnimations().forEach((animation) => {
        if (animation.id === "dashboard-flip") animation.cancel();
      });
      if (!node.classList.contains("dashboard-widget-active")) {
        node.style.removeProperty("transform");
      }
    });

    const gridRect = grid.getBoundingClientRect();
    nodes.forEach((node) => {
      if (node.classList.contains("dashboard-widget-active")) return;
      const id = node.dataset.widgetId;
      const prev = id ? before.get(id) : undefined;
      if (!prev) return;
      const rect = node.getBoundingClientRect();
      const dx = prev.x - (rect.left - gridRect.left);
      const dy = prev.y - (rect.top - gridRect.top);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      node.animate(
        [
          { transform: `translate(${dx}px, ${dy}px)` },
          { transform: "translate(0px, 0px)" },
        ],
        { id: "dashboard-flip", duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    });
  }, [layout]);

  /**
   * 串行 + latest-wins：同一时刻只发一个请求；飞行期间的新布局合并成「待发」，
   * 当前请求完成后只发最新一份。失败保留本地布局，不退出编辑态。
   */
  const pump = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      while (pendingSave.current) {
        const doc = pendingSave.current;
        pendingSave.current = null;
        setSaveState("saving");
        setSaveError(null);
        let result: SaveResult;
        try {
          result = await save(doc);
        } catch {
          result = { error: "网络异常，保存失败" };
        }
        if (!mounted.current) return;
        if ("error" in result) {
          setSaveState("error");
          setSaveError(result.error);
          break;
        }
      }
      if (mounted.current && !pendingSave.current) setSaveState("saved");
    } finally {
      inFlight.current = false;
    }
  }, [save]);

  function enqueueSave(next: DashboardLayoutDoc, delay = 0) {
    pendingSave.current = next;
    setSaveState("saving");
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (delay > 0) {
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void pump();
      }, delay);
    } else {
      void pump();
    }
  }

  const flushPending = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingSave.current) void pump();
  }, [pump]);

  function retrySave() {
    pendingSave.current = layoutRef.current;
    setSaveState("saving");
    void pump();
  }

  function commit(next: DashboardLayoutDoc, delay = 0) {
    applyLayout(next);
    enqueueSave(next, delay);
  }

  const { begin, activeId, isInteracting } = useGridInteraction({
    gridRef,
    getLayout: () => layoutRef.current,
    // 与 LayoutGrid 的 gridMetrics(layout.zoom) 保持一致：缩放改行高与间距
    getMetrics: () => gridMetrics(layoutRef.current.zoom),
    getScrollContainer,
    onPreview: applyLayout,
    onCommit: (doc) => {
      applyLayout(doc);
      enqueueSave(doc);
    },
  });

  /**
   * 助手在面板里改了布局：把刚落库的文档直接换上来。
   * 等 props 等不到 —— 本状态只在挂载时播种，常驻栏所在的共享 layout 在客户端导航时也不重渲染。
   * 正在拖拽、或还有未落库的本地改动时一律不覆盖：用户手上的动作优先。
   */
  const runtime = useRef({ applyLayout, isInteracting });
  useEffect(() => {
    runtime.current = { applyLayout, isInteracting };
  });
  useEffect(() => {
    function onSaved(event: Event) {
      const detail = (event as CustomEvent<unknown>).detail;
      if (!isLayoutSavedDetail(detail) || detail.surface !== surface) return;
      if (runtime.current.isInteracting()) return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      pendingSave.current = null;
      runtime.current.applyLayout(detail.doc);
      setSaveState("idle");
      setSaveError(null);
    }
    window.addEventListener(LAYOUT_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(LAYOUT_SAVED_EVENT, onSaved);
  }, [surface]);

  function handleAdd(type: DashboardWidgetId) {
    commit(
      addFullWidth ? addWidgetFullWidth(layoutRef.current, type) : addWidget(layoutRef.current, type),
    );
  }

  function handleRemove(id: string) {
    commit(removeWidget(layoutRef.current, id));
  }

  function handleReset() {
    if (
      !window.confirm(
        "恢复默认布局？已添加的卡片与各卡片的自定义设置（便签、倒计时、时钟、日程表分区）都会清空。",
      )
    ) {
      return;
    }
    commit(getResetLayout());
  }

  function handleConfigChange(id: string): ConfigChange {
    const change: ConfigChange = (patch: DashboardWidgetConfig, immediate = false) => {
      const next = updateWidgetConfig(layoutRef.current, id, patch);
      applyLayout(next);
      enqueueSave(next, immediate ? 0 : 600);
    };
    return change;
  }

  function handleKeyNudge(
    e: ReactKeyboardEvent<HTMLElement>,
    id: string,
    mode: "move" | "resize",
  ) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    const item = layoutRef.current.items.find((it) => it.id === id);
    if (!item) return;

    const effective = e.shiftKey ? (mode === "move" ? "resize" : "move") : mode;
    const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;

    const next =
      effective === "move"
        ? moveWidget(layoutRef.current, id, item.x + dx, item.y + dy)
        : resizeWidget(layoutRef.current, id, item.w + dx, item.h + dy);
    commit(next, 350);
  }

  /** 缩放写进同一个布局信封（与卡片坐标一起保存）；100% 等价于不带字段 */
  function setZoom(zoom: number) {
    const z = normalizeZoom(zoom);
    const current = layoutRef.current;
    const next: DashboardLayoutDoc = {
      v: 1,
      items: current.items,
      ...(z !== undefined ? { zoom: z } : {}),
    };
    commit(next);
  }

  return {
    layout,
    layoutRef,
    gridRef,
    saveState,
    saveError,
    applyLayout,
    commit,
    enqueueSave,
    flushPending,
    retrySave,
    handleAdd,
    handleRemove,
    handleReset,
    handleConfigChange,
    handleKeyNudge,
    handleZoomChange: setZoom,
    begin,
    activeId,
    isInteracting,
  };
}
