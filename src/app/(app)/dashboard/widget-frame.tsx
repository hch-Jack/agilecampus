"use client";

import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { widgetOrder, type DashboardLayoutItem } from "@/lib/dashboard-layout";

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
  children: ReactNode;
}) {
  const style: CSSProperties = {
    gridColumn: `${item.x + 1} / span ${item.w}`,
    gridRow: `${item.y + 1} / span ${item.h}`,
    order: widgetOrder(item),
  };

  return (
    <section
      className={`dashboard-widget${dragging ? " dashboard-widget-active" : ""}${
        alert ? " dashboard-widget-alert" : ""
      }`}
      style={style}
      data-widget-id={item.id}
    >
      <div className="dashboard-widget-inner ac-card">
        <div className="dashboard-widget-content" inert={editing || undefined}>
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
          </>
        )}
      </div>
    </section>
  );
}
