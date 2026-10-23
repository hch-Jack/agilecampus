"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  GRID_COLUMNS,
  GRID_GAP,
  GRID_ROW_HEIGHT,
  moveWidget,
  resizeWidget,
  type DashboardLayoutDoc,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";

type Mode = "move" | "resize";

type Session = {
  id: DashboardWidgetId;
  mode: Mode;
  pointerId: number;
  startX: number;
  startY: number;
  startItem: { x: number; y: number; w: number; h: number };
  /** 按下那一刻的布局；每次移动都从它重算，避免往返拖动把别的卡越挤越远 */
  snapshot: DashboardLayoutDoc;
  latest: DashboardLayoutDoc;
  colStep: number;
  rowStep: number;
  moved: boolean;
};

/**
 * 网格拖拽 / 缩放的指针状态机。
 *
 * 只负责「按下 → 实时预览 → 松开提交」，布局怎么算全交给 dashboard-layout 的纯函数。
 * 坐标按 12 列网格吸附：列宽由网格实际宽度反推（含 gap），行高是固定像素。
 */
export function useGridInteraction({
  gridRef,
  getLayout,
  onPreview,
  onCommit,
}: {
  gridRef: RefObject<HTMLDivElement | null>;
  getLayout: () => DashboardLayoutDoc;
  onPreview: (doc: DashboardLayoutDoc) => void;
  onCommit: (doc: DashboardLayoutDoc) => void;
}) {
  const sessionRef = useRef<Session | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [activeId, setActiveId] = useState<DashboardWidgetId | null>(null);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: DashboardWidgetId, mode: Mode) => {
      if (sessionRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const grid = gridRef.current;
      const item = getLayout().items.find((it) => it.id === id);
      if (!grid || !item) return;

      event.preventDefault();
      event.stopPropagation();

      const rect = grid.getBoundingClientRect();
      const colStep =
        (rect.width - GRID_GAP * (GRID_COLUMNS - 1)) / GRID_COLUMNS + GRID_GAP;
      const rowStep = GRID_ROW_HEIGHT + GRID_GAP;
      const snapshot = getLayout();

      const session: Session = {
        id,
        mode,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startItem: { x: item.x, y: item.y, w: item.w, h: item.h },
        snapshot,
        latest: snapshot,
        colStep,
        rowStep,
        moved: false,
      };
      const captureTarget = event.currentTarget;
      try {
        captureTarget.setPointerCapture(event.pointerId);
      } catch {
        // 某些触屏/旧浏览器不支持捕获；窗口监听仍能兜住大部分情况
      }

      sessionRef.current = session;
      setActiveId(id);
      document.body.classList.add("dashboard-dragging");

      function cleanup() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey);
        window.removeEventListener("blur", onBlur);
        captureTarget.removeEventListener("lostpointercapture", onLostCapture);
        try {
          if (captureTarget.hasPointerCapture(event.pointerId)) {
            captureTarget.releasePointerCapture(event.pointerId);
          }
        } catch {
          // 已释放
        }
        document.body.classList.remove("dashboard-dragging");
        sessionRef.current = null;
        cleanupRef.current = null;
        setActiveId(null);
      }

      function finish(commit: boolean) {
        const s = sessionRef.current;
        if (!s) return;
        cleanup();
        if (s.moved && commit) onCommit(s.latest);
        else if (s.moved) onPreview(s.snapshot);
      }

      function onMove(ev: PointerEvent) {
        const s = sessionRef.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        ev.preventDefault();

        const dc = Math.round((ev.clientX - s.startX) / s.colStep);
        const dr = Math.round((ev.clientY - s.startY) / s.rowStep);
        const next =
          s.mode === "move"
            ? moveWidget(s.snapshot, s.id, s.startItem.x + dc, s.startItem.y + dr)
            : resizeWidget(s.snapshot, s.id, s.startItem.w + dc, s.startItem.h + dr);

        if (dc !== 0 || dr !== 0) s.moved = true;
        s.latest = next;
        onPreview(next);

        // 靠近视口上下边缘时自动滚动，让长布局也能拖到屏幕外
        const edge = 64;
        if (ev.clientY < edge) window.scrollBy(0, -16);
        else if (ev.clientY > window.innerHeight - edge) window.scrollBy(0, 16);
      }

      function onUp(ev: PointerEvent) {
        if (ev.pointerId !== sessionRef.current?.pointerId) return;
        finish(true);
      }

      function onCancel() {
        finish(true);
      }

      function onKey(ev: KeyboardEvent) {
        if (ev.key !== "Escape") return;
        ev.preventDefault();
        ev.stopPropagation();
        finish(false);
      }

      function onBlur() {
        finish(true);
      }

      function onLostCapture(ev: PointerEvent) {
        if (ev.pointerId === sessionRef.current?.pointerId) finish(true);
      }

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", onMove, { passive: false });
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("blur", onBlur);
      captureTarget.addEventListener("lostpointercapture", onLostCapture);
    },
    [getLayout, gridRef, onCommit, onPreview],
  );

  const isInteracting = useCallback(() => sessionRef.current !== null, []);

  // 组件卸载（路由离开）时把监听与 body 类收干净
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  return { begin, activeId, isInteracting };
}
