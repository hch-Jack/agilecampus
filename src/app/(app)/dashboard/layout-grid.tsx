"use client";

import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  RefObject,
} from "react";
import {
  DASHBOARD_WIDGETS,
  gridMetrics,
  sortByCatalog,
  type DashboardLayoutDoc,
  type DashboardLayoutItem,
} from "@/lib/dashboard-layout";
import { WidgetFrame } from "./widget-frame";

/**
 * 12 列网格本体：工作台与常驻栏共用。
 *
 * 缩放只改行高与间距（`gridMetrics`），列数恒为 12；坐标不因缩放改变，
 * 相当于「同样大小里多塞或少塞几行」。
 */
export function LayoutGrid({
  gridRef,
  layout,
  editing,
  activeId,
  renderWidget,
  isAlert,
  onRemove,
  onDragStart,
  onResizeStart,
  onKeyNudge,
  className,
}: {
  gridRef: RefObject<HTMLDivElement | null>;
  layout: DashboardLayoutDoc;
  editing: boolean;
  activeId: string | null;
  renderWidget: (item: DashboardLayoutItem) => ReactNode;
  /** 需要处理的卡片（待办审批有内容）整卡高亮 */
  isAlert?: (item: DashboardLayoutItem) => boolean;
  onRemove: (id: string) => void;
  onDragStart: (e: ReactPointerEvent<HTMLElement>, id: string) => void;
  onResizeStart: (e: ReactPointerEvent<HTMLElement>, id: string) => void;
  onKeyNudge: (e: ReactKeyboardEvent<HTMLElement>, id: string, mode: "move" | "resize") => void;
  className?: string;
}) {
  const { rowHeight, gap } = gridMetrics(layout.zoom);
  const ordered = sortByCatalog(layout);

  return (
    <div
      ref={gridRef}
      className={className ? `dashboard-grid ${className}` : "dashboard-grid"}
      style={{ gridAutoRows: `${rowHeight}px`, gap: `${gap}px` }}
    >
      {editing && <div className="dashboard-edit-frame" aria-hidden />}
      {ordered.map((item) => (
        <WidgetFrame
          key={item.id}
          item={item}
          title={DASHBOARD_WIDGETS[item.type].title}
          editing={editing}
          dragging={activeId === item.id}
          alert={isAlert?.(item) ?? false}
          onRemove={() => onRemove(item.id)}
          onDragStart={(e) => onDragStart(e, item.id)}
          onResizeStart={(e) => onResizeStart(e, item.id)}
          onKeyNudge={(e, mode) => onKeyNudge(e, item.id, mode)}
        >
          {renderWidget(item)}
        </WidgetFrame>
      ))}
    </div>
  );
}
