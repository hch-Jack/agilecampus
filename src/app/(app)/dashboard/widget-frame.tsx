"use client";

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import {
  CARD_SCALE_MAX,
  CARD_SCALE_MIN,
  CARD_SCALE_STEP,
  normalizeCardScale,
  widgetOrder,
  type DashboardLayoutItem,
} from "@/lib/dashboard-layout";

/**
 * 网格里的一张卡：定位、内容壳，以及编辑态的拖拽层 / 顶部栏 / 缩放手柄。
 *
 * 内容区在编辑态加 `inert` —— 只靠透明覆盖层挡不住键盘 Tab；
 * 移除按钮浮在右上角（层级高于覆盖层），不占卡片高度，任何时候都点得到。
 */
export function WidgetFrame({
  item,
  title,
  editing,
  dragging,
  alert = false,
  onRemove,
  onDragStart,
  onResizeStart,
  onKeyNudge,
  onScaleChange,
  children,
}: {
  item: DashboardLayoutItem;
  title: string;
  editing: boolean;
  dragging: boolean;
  /** 有内容需要处理（待办审批）时整卡高亮成橙色，一眼可见 */
  alert?: boolean;
  onRemove: () => void;
  onDragStart: (e: ReactPointerEvent<HTMLElement>) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLElement>) => void;
  onKeyNudge: (e: ReactKeyboardEvent<HTMLElement>, mode: "move" | "resize") => void;
  /** 单卡内容缩放；不传则编辑态不显示缩放控件 */
  onScaleChange?: (scale: number) => void;
  children: ReactNode;
}) {
  const style: CSSProperties = {
    gridColumn: `${item.x + 1} / span ${item.w}`,
    gridRow: `${item.y + 1} / span ${item.h}`,
    order: widgetOrder(item),
  };
  const scale = normalizeCardScale(item.scale) ?? 1;
  const scaleStep = (dir: -1 | 1) =>
    onScaleChange?.(Math.round((scale + dir * CARD_SCALE_STEP) * 100) / 100);

  return (
    <section
      className={`dashboard-widget${dragging ? " dashboard-widget-active" : ""}${
        alert ? " dashboard-widget-alert" : ""
      }`}
      style={style}
      data-widget-id={item.id}
    >
      <div className="dashboard-widget-inner ac-card">
        <div
          className="dashboard-widget-content"
          style={{ "--dw-card-scale": String(scale) } as CSSProperties}
          inert={editing || undefined}
        >
          {children}
        </div>

        {editing && (
          <>
            <div
              role="button"
              tabIndex={0}
              aria-label={`拖动「${title}」；方向键移动，Shift + 方向键调整大小`}
              className="dashboard-widget-overlay"
              onPointerDown={onDragStart}
              onKeyDown={(e) => onKeyNudge(e, "move")}
            />
            <button
              type="button"
              onClick={onRemove}
              aria-label={`移除「${title}」`}
              className="dashboard-widget-remove"
            >
              移除
            </button>
            <div
              role="button"
              tabIndex={0}
              aria-label={`调整「${title}」大小；方向键调整，Shift + 方向键移动`}
              className="dashboard-widget-resize"
              onPointerDown={onResizeStart}
              onKeyDown={(e) => onKeyNudge(e, "resize")}
            >
              <span aria-hidden>⤡</span>
            </div>
            {onScaleChange && (
              <div
                role="group"
                aria-label={`调整「${title}」内容大小`}
                className="dashboard-widget-scale"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={() => scaleStep(-1)}
                  disabled={scale <= CARD_SCALE_MIN + 1e-6}
                  aria-label="缩小内容"
                  title="缩小卡片内容"
                >
                  −
                </button>
                <span aria-live="polite" title="卡片内容缩放">
                  {Math.round(scale * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => scaleStep(1)}
                  disabled={scale >= CARD_SCALE_MAX - 1e-6}
                  aria-label="放大内容"
                  title="放大卡片内容"
                >
                  +
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
