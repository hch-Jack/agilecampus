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
  /** 按下时的指针位置（内容坐标 = client + scroll，自动滚动也能继续往下拖） */
  startX: number;
  startY: number;
  startItem: { x: number; y: number; w: number; h: number };
  /** 被拖 / 缩放的卡片根节点：拖动时给它叠一层亚格子的 transform，跟手不跳格 */
  node: HTMLElement | null;
  /** 按下瞬间卡片已有的视觉偏移（上一轮 FLIP 还没飞完时抓住它，别让它跳一下） */
  offsetX: number;
  offsetY: number;
  /** 按下那一刻的布局；每次移动都从它重算，避免往返拖动把别的卡越挤越远 */
  snapshot: DashboardLayoutDoc;
  latest: DashboardLayoutDoc;
  colStep: number;
  rowStep: number;
  moved: boolean;
};

/** 卡片当前的视觉位移（含正在飞的 FLIP 动画）；没有 transform 就是 0。 */
function readVisualOffset(node: HTMLElement): { x: number; y: number } {
  const transform = getComputedStyle(node).transform;
  if (!transform || transform === "none") return { x: 0, y: 0 };
  const matrix = new DOMMatrixReadOnly(transform);
  return { x: matrix.m41, y: matrix.m42 };
}

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
      const node = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-widget-id]");
      // 上一轮 FLIP 还没飞完就再次按下时先收掉，否则动画会盖住这次的亚格子 transform；
      // 把当时的视觉偏移记下来当作起点，卡片就不会瞬移
      const { x: offsetX, y: offsetY } = node ? readVisualOffset(node) : { x: 0, y: 0 };
      node?.getAnimations().forEach((animation) => {
        if (animation.id === "dashboard-flip") animation.cancel();
      });

      const session: Session = {
        id,
        mode,
        pointerId: event.pointerId,
        startX: event.clientX + window.scrollX,
        startY: event.clientY + window.scrollY,
        startItem: { x: item.x, y: item.y, w: item.w, h: item.h },
        node,
        offsetX,
        offsetY,
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
        // 即使吸附位置没变也提交一次：让 DashboardGrid 的 FLIP 收掉亚格子位移，
        // 卡片从鼠标处滑入格子，而不是瞬间跳回去
        if (s.moved && commit) onCommit(s.latest);
        else if (s.moved) onPreview(s.snapshot);
      }

      function onMove(ev: PointerEvent) {
        const s = sessionRef.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        ev.preventDefault();

        // 内容坐标：自动滚动时 clientY 不变，内容坐标会继续增长，卡片因此能拖到屏幕外
        const contentX = ev.clientX + window.scrollX;
        const contentY = ev.clientY + window.scrollY;
        const dx = contentX - s.startX;
        const dy = contentY - s.startY;
        const dc = Math.round(dx / s.colStep);
        const dr = Math.round(dy / s.rowStep);
        const next =
          s.mode === "move"
            ? moveWidget(s.snapshot, s.id, s.startItem.x + dc, s.startItem.y + dr)
            : resizeWidget(s.snapshot, s.id, s.startItem.w + dc, s.startItem.h + dr);

        if (dx !== 0 || dy !== 0) s.moved = true;

        // 亚格子位移：网格仍按整格吸附，但被拖的卡片用 transform 补上那不到一格的差距，
        // 于是鼠标移动时卡片连续跟手，松手后再滑入吸附位（FLIP 收尾）。
        if (s.mode === "move" && s.node) {
          const residualX = s.offsetX + dx - dc * s.colStep;
          const residualY = s.offsetY + dy - dr * s.rowStep;
          s.node.style.transform = `translate3d(${residualX}px, ${residualY}px, 0)`;
        }

        // 吸附位置没变就不触发重渲染，省掉每个像素都重排一遍的开销
        const prevActive = s.latest.items.find((it) => it.id === s.id);
        const nextActive = next.items.find((it) => it.id === s.id);
        const changed =
          !prevActive ||
          !nextActive ||
          prevActive.x !== nextActive.x ||
          prevActive.y !== nextActive.y ||
          prevActive.w !== nextActive.w ||
          prevActive.h !== nextActive.h;

        s.latest = next;
        if (changed) onPreview(next);

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
