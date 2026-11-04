"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  defaultRailLayoutFor,
  normalizeLayoutDoc,
  type DashboardLayoutDoc,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import type { DashboardData } from "../dashboard/dashboard-types";
import { LayoutGrid } from "../dashboard/layout-grid";
import { useLayoutEditor } from "../dashboard/use-layout-editor";
import { WidgetLibrary } from "../dashboard/widget-library";
import { renderWidgetContent } from "../dashboard/widget-content";
import { ZoomControl } from "../dashboard/zoom-control";
import {
  refreshRailDataAction,
  saveRailCollapsedAction,
  saveRailLayoutAction,
} from "./actions";
import "../dashboard/dashboard.css";

/**
 * 全域常驻栏：每个登录页面左侧一条，放工作台卡片。
 *
 * - 卡片在任何页面都可正常交互；栏头有**自己的**「编辑」按钮，与工作台编辑互不影响。
 * - 布局存在 `users.rail_layout`，缩放随布局一起存。
 * - 默认收起；收起 / 展开按账号存 `users.rail_collapsed`，服务端首屏就按上次的选择渲染。
 * - 可与助手抽屉同时展开。
 * - < 1024px 由 CSS 整条隐藏（手机端不做浮层）。
 */
export function AppRail({
  initialLayout,
  initialData,
  initialCollapsed,
}: {
  initialLayout: DashboardLayoutDoc;
  initialData: DashboardData;
  /** 由 layout 从 cookie 读出的初始状态；缺省收起 */
  initialCollapsed: boolean;
}) {
  const pathname = usePathname();

  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [editing, setEditing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [data, setData] = useState<DashboardData>(initialData);
  const scrollRef = useRef<HTMLDivElement>(null);

  const {
    layout,
    gridRef,
    saveState,
    saveError,
    flushPending,
    retrySave,
    handleAdd,
    handleRemove,
    handleReset,
    handleConfigChange,
    handleKeyNudge,
    handleZoomChange,
    begin,
    activeId,
    isInteracting,
  } = useLayoutEditor({
    initialLayout,
    surface: "rail",
    save: saveRailLayoutAction,
    getResetLayout: () => normalizeLayoutDoc(defaultRailLayoutFor(data.isApprover)),
    // 常驻栏窄，新卡默认满宽
    addFullWidth: true,
    getScrollContainer: () => scrollRef.current,
  });

  // 布局里的卡片类型集合：用作数据刷新与依赖比较的稳定键
  const typesKey = useMemo(
    () => [...new Set(layout.items.map((item) => item.type))].sort().join(","),
    [layout.items],
  );
  const types = useMemo(
    () => (typesKey ? (typesKey.split(",") as DashboardWidgetId[]) : []),
    [typesKey],
  );

  // 共享 layout 在客户端导航时不会重新渲染：路由切换、增删卡片后自己刷数据。
  // 首次挂载已带服务端数据，跳过；StrictMode 的二次挂载也靠这个键挡住。
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const key = `${pathname}|${typesKey}`;
    if (lastKey.current === null) {
      lastKey.current = key;
      return;
    }
    if (lastKey.current === key) return;
    lastKey.current = key;

    let cancelled = false;
    const timer = setTimeout(() => {
      void refreshRailDataAction(types)
        .then((result) => {
          if (!cancelled && "data" in result) setData(result.data);
        })
        .catch(() => {
          // 刷新失败保留旧数据；下一次路由切换 / 增删卡会再试
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pathname, types, typesKey]);

  // Esc 退出编辑（拖拽中由指针状态机自己处理：回滚本次拖动）
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isInteracting()) return;
      flushPending();
      setLibraryOpen(false);
      setEditing(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, flushPending, isInteracting]);

  function exitEditing() {
    flushPending();
    setLibraryOpen(false);
    setEditing(false);
  }

  /** 先本地切换，再按账号落库：下次登录（换设备也一样）沿用这次的选择 */
  function setCollapsedPreference(next: boolean) {
    setCollapsed(next);
    void saveRailCollapsedAction(next).catch(() => {
      // 落库失败不影响本次切换；下次再点会重试
    });
  }

  function collapse() {
    // 收起时不留编辑中间态
    exitEditing();
    setCollapsedPreference(true);
  }

  return (
    <aside
      className={`app-rail${collapsed ? " is-collapsed" : ""}${editing ? " is-editing" : ""}`}
      aria-label="常驻栏"
    >
      {collapsed ? (
        <button
          type="button"
          className="rail-strip"
          onClick={() => setCollapsedPreference(false)}
          aria-label="展开常驻栏"
          aria-expanded={false}
        >
          <span aria-hidden>»</span>
          <span className="rail-strip-label" aria-hidden>
            常驻栏
          </span>
        </button>
      ) : (
        <>
          <div className="rail-scroll" ref={scrollRef}>
            <div className={`rail-shell${editing ? " is-editing" : ""}`}>
              <div className="rail-head">
                <span className="rail-title">常驻栏</span>
                <button
                  type="button"
                  className={`rail-edit${editing ? " is-on" : ""}`}
                  onClick={() => (editing ? exitEditing() : setEditing(true))}
                  aria-pressed={editing}
                >
                  {editing ? "完成" : "编辑"}
                </button>
              </div>

              {editing && (
                <div className="rail-toolbar">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setLibraryOpen((open) => !open)}
                      className="ac-btn-ghost px-2.5 py-1 text-xs"
                    >
                      添加卡片
                    </button>
                    <button
                      type="button"
                      onClick={handleReset}
                      className="ac-btn-ghost px-2.5 py-1 text-xs"
                    >
                      恢复默认
                    </button>
                    {saveState === "error" && (
                      <button
                        type="button"
                        onClick={retrySave}
                        className="text-xs text-high underline underline-offset-2"
                        title={saveError ?? undefined}
                      >
                        保存失败，重试
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-1.5">
                    <ZoomControl zoom={layout.zoom} onChange={handleZoomChange} />
                    <span aria-live="polite" className="text-[11px] text-ink-faint">
                      {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : null}
                    </span>
                  </div>
                </div>
              )}

              {editing && libraryOpen && (
                <div className="rail-library">
                  <WidgetLibrary
                    layout={layout}
                    onAdd={(type) => {
                      handleAdd(type);
                      // 常驻栏很窄：加完就收起面板并滚到新卡，否则「看起来没反应」
                      setLibraryOpen(false);
                      setTimeout(() => {
                        const rail = scrollRef.current;
                        rail?.scrollTo({ top: rail.scrollHeight, behavior: "smooth" });
                      }, 60);
                    }}
                    onClose={() => setLibraryOpen(false)}
                    compact
                  />
                </div>
              )}

              {layout.items.length === 0 ? (
                <p className="rail-empty">
                  {editing ? "还没有卡片，点「添加卡片」挑几张。" : "常驻栏是空的。"}
                </p>
              ) : (
                <LayoutGrid
                  gridRef={gridRef}
                  layout={layout}
                  editing={editing}
                  activeId={activeId}
                  renderWidget={(item) =>
                    renderWidgetContent(item, data, editing, handleConfigChange)
                  }
                  isAlert={(item) => item.type === "approvals" && data.approvals.length > 0}
                  onRemove={handleRemove}
                  onDragStart={(e, id) => begin(e, id, "move")}
                  onResizeStart={(e, id) => begin(e, id, "resize")}
                  onKeyNudge={handleKeyNudge}
                />
              )}
            </div>
          </div>

          {/* 收起按钮钉在栏的右缘中点：够大、够好点，也不挡栏头 */}
          <button
            type="button"
            className="rail-collapse"
            onClick={collapse}
            aria-label="收起常驻栏"
            title="收起常驻栏"
          >
            <span aria-hidden>«</span>
          </button>
        </>
      )}
    </aside>
  );
}
