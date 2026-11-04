"use client";

import { useEffect, useRef, useState } from "react";
import {
  defaultDashboardLayoutFor,
  normalizeLayoutDoc,
  type DashboardLayoutDoc,
} from "@/lib/dashboard-layout";
import { saveDashboardLayoutAction } from "./actions";
import { useDashboardEdit } from "./dashboard-edit-context";
import type { DashboardData } from "./dashboard-types";
import { LayoutGrid } from "./layout-grid";
import { useLayoutEditor } from "./use-layout-editor";
import { WidgetLibrary } from "./widget-library";
import { renderWidgetContent } from "./widget-content";
import { ZoomControl } from "./zoom-control";
import "./dashboard.css";

export function DashboardGrid({
  initialLayout,
  data,
}: {
  initialLayout: DashboardLayoutDoc;
  data: DashboardData;
}) {
  const { editing, setEditing } = useDashboardEdit();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

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
    surface: "dashboard",
    save: saveDashboardLayoutAction,
    // 审批人恢复的是「带待办审批卡」的默认布局，与首次进入时一致；
    // 这里不能直接用通用 DEFAULT_DASHBOARD_LAYOUT，否则审批卡会凭空消失。
    getResetLayout: () => normalizeLayoutDoc(defaultDashboardLayoutFor(data.isApprover)),
  });

  // 离开工作台即退出编辑（常驻栏有自己的编辑开关，不受这里影响）
  useEffect(() => {
    return () => setEditing(false);
  }, [setEditing]);

  // Esc 退出编辑（拖拽中由指针状态机自己处理：回滚本次拖动）
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || isInteracting()) return;
      setEditing(false);
      setLibraryOpen(false);
      flushPending();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, flushPending, isInteracting, setEditing]);

  // 窄屏 / 打开助手抽屉把正文挤到 720px 以下时，自动退出编辑，
  // 避免工具栏被 CSS 藏起来后卡在编辑中间态
  useEffect(() => {
    if (!editing) return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const onMediaChange = () => {
      if (mq.matches) {
        setEditing(false);
        setLibraryOpen(false);
      }
    };
    mq.addEventListener("change", onMediaChange);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width < 720) {
          setEditing(false);
          setLibraryOpen(false);
          return;
        }
      }
    });
    if (shellRef.current) observer.observe(shellRef.current);

    return () => {
      mq.removeEventListener("change", onMediaChange);
      observer.disconnect();
    };
  }, [editing, setEditing]);

  function exitEditing() {
    setEditing(false);
    setLibraryOpen(false);
    flushPending();
  }

  return (
    <div ref={shellRef} className={`dashboard-shell${editing ? " is-editing" : ""}`}>
      <header className="dashboard-header flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">工作台</h1>
          <p className="mt-0.5 text-xs text-ink-faint">
            {editing
              ? "拖动卡片移动 · 拖右下角缩放 · 左右虚线内都可放置"
              : "把常用信息收进一页；编辑模式可自由拖动、缩放与增删卡片"}
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {editing ? (
            <>
              <span
                aria-live="polite"
                className="text-xs text-ink-faint"
                title={saveError ?? undefined}
              >
                {saveState === "saving"
                  ? "保存中…"
                  : saveState === "error"
                    ? null
                    : saveState === "saved"
                      ? "已保存"
                      : null}
              </span>
              {saveState === "error" && (
                <button
                  type="button"
                  onClick={retrySave}
                  className="text-xs text-high underline underline-offset-2"
                >
                  保存失败，重试
                </button>
              )}
              <button
                type="button"
                onClick={() => setLibraryOpen((open) => !open)}
                className="ac-btn-ghost px-3 py-1.5 text-xs"
              >
                添加卡片
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="ac-btn-ghost px-3 py-1.5 text-xs"
              >
                恢复默认
              </button>
              <ZoomControl zoom={layout.zoom} onChange={handleZoomChange} />
              <button type="button" onClick={exitEditing} className="ac-btn px-3 py-1.5 text-xs">
                完成
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="ac-btn-ghost dashboard-edit-toggle px-3 py-1.5 text-xs"
            >
              编辑工作台
            </button>
          )}
        </div>
      </header>

      <div className="mt-4 space-y-4">
        {editing && libraryOpen && (
          <WidgetLibrary
            layout={layout}
            onAdd={handleAdd}
            onClose={() => setLibraryOpen(false)}
          />
        )}

        {layout.items.length === 0 ? (
          <div className="ac-card p-8 text-center">
            <p className="text-sm text-ink-soft">工作台还没有卡片。</p>
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditing(true);
                  setLibraryOpen(true);
                }}
                className="ac-btn-ghost dashboard-edit-toggle px-3 py-1.5 text-xs"
              >
                添加卡片
              </button>
              <button
                type="button"
                onClick={handleReset}
                className="ac-btn-ghost dashboard-edit-toggle px-3 py-1.5 text-xs"
              >
                恢复默认
              </button>
            </div>
          </div>
        ) : (
          <LayoutGrid
            gridRef={gridRef}
            layout={layout}
            editing={editing}
            activeId={activeId}
            renderWidget={(item) => renderWidgetContent(item, data, editing, handleConfigChange)}
            isAlert={(item) => item.type === "approvals" && data.approvals.length > 0}
            onRemove={handleRemove}
            onDragStart={(e, id) => begin(e, id, "move")}
            onResizeStart={(e, id) => begin(e, id, "resize")}
            onKeyNudge={handleKeyNudge}
          />
        )}
      </div>
    </div>
  );
}
