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
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_LAYOUT,
  addWidget,
  moveWidget,
  normalizeLayoutDoc,
  removeWidget,
  resizeWidget,
  sortByCatalog,
  updateWidgetConfig,
  type DashboardLayoutDoc,
  type DashboardLayoutItem,
  type DashboardWidgetConfig,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import type { WorkbenchStatKey } from "@/lib/workbench-stats";
import { ActivityFeed } from "@/components/activity-feed";
import { saveDashboardLayoutAction } from "./actions";
import type { DashboardData } from "./dashboard-types";
import { WidgetFrame } from "./widget-frame";
import { WidgetLibrary } from "./widget-library";
import { useGridInteraction } from "./use-grid-interaction";
import { WorkbenchBoard } from "./workbench-board";
import { StatWidget } from "./widgets/stats";
import {
  MessagesWidget,
  MyProjectsWidget,
  MyTeamsWidget,
  QuickLinksWidget,
  UpcomingWidget,
} from "./widgets/lists";
import { ClockWidget, CountdownWidget, NoteWidget, type ConfigChange } from "./widgets/personal";
import {
  FocusTimerWidget,
  MilestonesWidget,
  RecentAttachmentsWidget,
  ResourceUsageWidget,
} from "./widgets/productivity";
import { ApprovalsWidget } from "./widgets/approvals";
import "./dashboard.css";

type SaveState = "idle" | "saving" | "saved" | "error";

const STAT_KEYS: Partial<Record<DashboardWidgetId, WorkbenchStatKey>> = {
  stat_overdue: "overdue",
  stat_today: "today",
  stat_week: "week",
  stat_doing: "doing",
};

export function DashboardGrid({
  initialLayout,
  data,
}: {
  initialLayout: DashboardLayoutDoc;
  data: DashboardData;
}) {
  // 只在挂载时播种一次：之后 router.refresh / 筛选导航带回的 props 不得覆盖本地未保存布局
  const [layout, setLayout] = useState<DashboardLayoutDoc>(initialLayout);
  const layoutRef = useRef(layout);
  const [editing, setEditing] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSave = useRef<DashboardLayoutDoc | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
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
    setLayout({ v: next.v, items: next.items });
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
        let result: { ok: true } | { error: string };
        try {
          result = await saveDashboardLayoutAction(doc);
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
  }, []);

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
    onPreview: applyLayout,
    onCommit: (doc) => {
      applyLayout(doc);
      enqueueSave(doc);
    },
  });

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
  }, [editing, flushPending, isInteracting]);

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
  }, [editing]);

  function handleAdd(type: DashboardWidgetId) {
    commit(addWidget(layoutRef.current, type));
  }

  function handleRemove(id: string) {
    commit(removeWidget(layoutRef.current, id));
  }

  function handleReset() {
    if (
      !window.confirm(
        "恢复默认布局？已添加的卡片、便签内容与倒计时设置都会清空。",
      )
    ) {
      return;
    }
    commit(normalizeLayoutDoc(DEFAULT_DASHBOARD_LAYOUT));
  }

  function handleConfigChange(id: string) {
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

  function exitEditing() {
    setEditing(false);
    setLibraryOpen(false);
    flushPending();
  }

  function renderWidget(item: DashboardLayoutItem) {
    const statKey = STAT_KEYS[item.type];
    if (statKey) return <StatWidget statKey={statKey} value={data.stats[statKey]} />;

    switch (item.type) {
      case "task_board":
        return (
          <WorkbenchBoard
            tasks={data.visibleTasks}
            today={data.today}
            doneCount={data.doneCount}
            hideDone={data.hideDone}
            chips={data.chips}
            projectFilter={data.projectFilter}
            locked={editing}
          />
        );
      case "activity_feed":
        return (
          <ActivityFeed
            activities={data.feed}
            tz={data.tz}
            now={data.now}
            showProject
            unreadScope={data.feedScope}
            unreadCount={data.feedUnread}
            clearScope={data.feedScope}
            embedded
            fill
          />
        );
      case "my_projects":
        return <MyProjectsWidget projects={data.projects} />;
      case "upcoming":
        return <UpcomingWidget tasks={data.upcoming} today={data.today} />;
      case "my_teams":
        return <MyTeamsWidget teams={data.teams} />;
      case "unread_messages":
        return <MessagesWidget messages={data.messages} />;
      case "quick_links":
        return <QuickLinksWidget />;
      case "milestones":
        return <MilestonesWidget milestones={data.milestones} today={data.today} />;
      case "resource_usage":
        return <ResourceUsageWidget usages={data.resourceUsages} tz={data.tz} />;
      case "recent_attachments":
        return <RecentAttachmentsWidget attachments={data.attachments} tz={data.tz} />;
      case "approvals":
        return <ApprovalsWidget approvals={data.approvals} tz={data.tz} />;
      case "focus_timer":
        return <FocusTimerWidget instanceId={item.id} />;
      case "note":
        return <NoteWidget config={item.config} onConfigChange={handleConfigChange(item.id)} />;
      case "clock":
        return (
          <ClockWidget
            tz={data.tz}
            config={item.config}
            onConfigChange={handleConfigChange(item.id)}
          />
        );
      case "countdown":
        return (
          <CountdownWidget
            tz={data.tz}
            config={item.config}
            onConfigChange={handleConfigChange(item.id)}
          />
        );
      default:
        return null;
    }
  }

  const ordered = sortByCatalog(layout);

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
          <div ref={gridRef} className="dashboard-grid">
            {editing && <div className="dashboard-edit-frame" aria-hidden />}
            {ordered.map((item) => (
              <WidgetFrame
                key={item.id}
                item={item}
                title={DASHBOARD_WIDGETS[item.type].title}
                editing={editing}
                dragging={activeId === item.id}
                onRemove={() => handleRemove(item.id)}
                onDragStart={(e) => begin(e, item.id, "move")}
                onResizeStart={(e) => begin(e, item.id, "resize")}
                onKeyNudge={(e, mode) => handleKeyNudge(e, item.id, mode)}
              >
                {renderWidget(item)}
              </WidgetFrame>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
