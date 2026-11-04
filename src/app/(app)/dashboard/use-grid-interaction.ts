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
  DASHBOARD_WIDGETS,
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
  /** 实例 id（可重复卡片可能是 `note-2`） */
  id: string;
  /** 卡片类型：决定最小尺寸 */
  type: DashboardWidgetId;
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
  /** 缩放起点：卡片的实际渲染宽高（px），拖动时按它连续算出想要的尺寸 */
  baseW: number;
  baseH: number;
  /** 按下那一刻的布局；每次移动都从它重算，避免往返拖动把别的卡越挤越远 */
  snapshot: DashboardLayoutDoc;
  latest: DashboardLayoutDoc;
  colStep: number;
  rowStep: number;
  /** 当前缩放下的格子间距（px）；缩放只改行高与间距 */
  gap: number;
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
 * 拖动预览时把被拖的卡片钉在起点：网格基底不动，只有 transform 跟手。
 * 否则每次跨格都要等 React 提交新位置，而 transform 已经按新格子写好了，
 * 中间会有一两帧按旧格子偏移，看起来就是闪跳。
 */
function pinMovedItem(doc: DashboardLayoutDoc, id: string, x: number, y: number) {
  return {
    v: doc.v,
    items: doc.items.map((it) => (it.id === id ? { ...it, x, y } : it)),
  };
}

/** 缩放松手 / 取消：把显式像素尺寸动画回吸附后的格子尺寸，再交还给网格。 */
function settleResize(s: Session, commit: boolean) {
  const node = s.node;
  if (!node) return;
  const rect = node.getBoundingClientRect();
  const target = (commit ? s.latest : s.snapshot).items.find((it) => it.id === s.id);
  node.style.removeProperty("width");
  node.style.removeProperty("height");
  if (!target) return;
  const toW = target.w * s.colStep - s.gap;
  const toH = target.h * s.rowStep - s.gap;
  if (Math.abs(rect.width - toW) < 0.5 && Math.abs(rect.height - toH) < 0.5) return;
  node.animate(
    [
      { width: `${rect.width}px`, height: `${rect.height}px` },
      { width: `${toW}px`, height: `${toH}px` },
    ],
    { id: "dashboard-resize", duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" },
  );
}

/**
 * 网格拖拽 / 缩放的指针状态机。
 *
 * 只负责「按下 → 实时预览 → 松开提交」，布局怎么算全交给 dashboard-layout 的纯函数。
 * 坐标按 12 列网格吸附：列宽由网格实际宽度反推（含 gap），行高由 `getMetrics` 给出
 * （工作台与常驻栏的缩放各算各的）。
 *
 * `getScrollContainer` 用于常驻栏这种「自身滚动、页面不滚」的容器：
 * 内容坐标与边缘自动滚动都作用在它身上；缺省仍按整页（window）算。
 */
export function useGridInteraction({
  gridRef,
  getLayout,
  onPreview,
  onCommit,
  getMetrics = () => ({ rowHeight: GRID_ROW_HEIGHT, gap: GRID_GAP }),
  getScrollContainer,
}: {
  gridRef: RefObject<HTMLDivElement | null>;
  getLayout: () => DashboardLayoutDoc;
  onPreview: (doc: DashboardLayoutDoc) => void;
  onCommit: (doc: DashboardLayoutDoc) => void;
  /** 缩放后的格子度量；缺省为标准尺寸 */
  getMetrics?: () => { rowHeight: number; gap: number };
  /** 拖拽时用于自动滚动的容器；缺省为整页 */
  getScrollContainer?: () => HTMLElement | null;
}) {
  const sessionRef = useRef<Session | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  /** 指针的内容坐标：随滚动容器（或页面）一起增长，拖到屏幕外也能继续 */
  const contentPoint = useCallback(
    (clientX: number, clientY: number) => {
      const sc = getScrollContainer?.() ?? null;
      if (sc) return { x: clientX + sc.scrollLeft, y: clientY + sc.scrollTop };
      return { x: clientX + window.scrollX, y: clientY + window.scrollY };
    },
    [getScrollContainer],
  );

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, mode: Mode) => {
      if (sessionRef.current) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const grid = gridRef.current;
      const item = getLayout().items.find((it) => it.id === id);
      if (!grid || !item) return;

      event.preventDefault();
      event.stopPropagation();

      const { rowHeight, gap } = getMetrics();
      const rect = grid.getBoundingClientRect();
      const colStep = (rect.width - gap * (GRID_COLUMNS - 1)) / GRID_COLUMNS + gap;
      const rowStep = rowHeight + gap;
      const start = contentPoint(event.clientX, event.clientY);
      const snapshot = getLayout();
      const node = (event.currentTarget as HTMLElement).closest<HTMLElement>("[data-widget-id]");
      // 上一轮 FLIP / 尺寸收尾还没飞完就再次按下时先收掉，否则动画会盖住这次的视觉位移
      const startRect = node?.getBoundingClientRect();
      const { x: offsetX, y: offsetY } = node ? readVisualOffset(node) : { x: 0, y: 0 };
      node?.getAnimations().forEach((animation) => {
        if (animation.id === "dashboard-flip" || animation.id === "dashboard-resize") {
          animation.cancel();
        }
      });
      // 缩放从「当前看到的尺寸」起算；先写成显式像素，收掉动画时卡片才不会跳一下
      if (mode === "resize" && node && startRect) {
        node.style.width = `${startRect.width}px`;
        node.style.height = `${startRect.height}px`;
      }

      const session: Session = {
        id,
        type: item.type,
        mode,
        pointerId: event.pointerId,
        startX: start.x,
        startY: start.y,
        startItem: { x: item.x, y: item.y, w: item.w, h: item.h },
        node,
        offsetX,
        offsetY,
        baseW: startRect?.width ?? 0,
        baseH: startRect?.height ?? 0,
        snapshot,
        latest: snapshot,
        colStep,
        rowStep,
        gap,
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
        if (!s.moved) {
          if (s.mode === "resize" && s.node) {
            s.node.style.removeProperty("width");
            s.node.style.removeProperty("height");
          }
          return;
        }
        // 缩放松手先把尺寸滑回吸附尺寸；拖动则由 DashboardGrid 的 FLIP 收掉位移
        if (s.mode === "resize") settleResize(s, commit);
        // 即使吸附位置没变也提交一次：让 FLIP 收掉亚格子位移，
        // 卡片从鼠标处滑入格子，而不是瞬间跳回去
        if (commit) onCommit(s.latest);
        else onPreview(s.snapshot);
      }

      function onMove(ev: PointerEvent) {
        const s = sessionRef.current;
        if (!s || ev.pointerId !== s.pointerId) return;
        ev.preventDefault();

        // 内容坐标：自动滚动时 clientY 不变，内容坐标会继续增长，卡片因此能拖到屏幕外
        const point = contentPoint(ev.clientX, ev.clientY);
        const dx = point.x - s.startX;
        const dy = point.y - s.startY;
        const dc = Math.round(dx / s.colStep);
        const dr = Math.round(dy / s.rowStep);
        const next =
          s.mode === "move"
            ? moveWidget(s.snapshot, s.id, s.startItem.x + dc, s.startItem.y + dr)
            : resizeWidget(s.snapshot, s.id, s.startItem.w + dc, s.startItem.h + dr);

        if (dx !== 0 || dy !== 0) s.moved = true;

        // 拖动：卡片钉在起点，transform 就是完整的指针位移，连续跟手。
        // 缩放：宽高按指针连续算出来（夹在最小/最大尺寸内），网格吸附只用于别人让位。
        if (s.mode === "move" && s.node) {
          s.node.style.transform = `translate3d(${s.offsetX + dx}px, ${s.offsetY + dy}px, 0)`;
        } else if (s.mode === "resize" && s.node && s.baseW > 0 && s.baseH > 0) {
          const min = DASHBOARD_WIDGETS[s.type].minSize;
          const minW = min.w * s.colStep - s.gap;
          const maxW = (GRID_COLUMNS - s.startItem.x) * s.colStep - s.gap;
          const minH = min.h * s.rowStep - s.gap;
          const width = Math.min(Math.max(s.baseW + dx, minW), maxW);
          const height = Math.max(s.baseH + dy, minH);
          s.node.style.width = `${width}px`;
          s.node.style.height = `${height}px`;
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
        if (changed) {
          onPreview(
            s.mode === "move"
              ? pinMovedItem(next, s.id, s.startItem.x, s.startItem.y)
              : next,
          );
        }

        // 靠近可滚动区域的上下边缘时自动滚动，让长布局也能拖到屏幕外
        const edge = 64;
        const sc = getScrollContainer?.() ?? null;
        if (sc) {
          const scRect = sc.getBoundingClientRect();
          if (ev.clientY < scRect.top + edge) sc.scrollBy(0, -16);
          else if (ev.clientY > scRect.bottom - edge) sc.scrollBy(0, 16);
        } else if (ev.clientY < edge) {
          window.scrollBy(0, -16);
        } else if (ev.clientY > window.innerHeight - edge) {
          window.scrollBy(0, 16);
        }
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
    [contentPoint, getLayout, getMetrics, getScrollContainer, gridRef, onCommit, onPreview],
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
