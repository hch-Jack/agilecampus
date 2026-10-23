import { describe, it, expect } from "vitest";
import {
  COUNTDOWN_TITLE_MAX_LENGTH,
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_LAYOUT,
  GRID_COLUMNS,
  NOTE_MAX_LENGTH,
  STAT_WIDGET_IDS,
  WIDGET_IDS,
  addWidget,
  moveWidget,
  normalizeLayoutDoc,
  removeWidget,
  resizeWidget,
  sortByCatalog,
  updateWidgetConfig,
  widgetOrder,
  type DashboardLayoutDoc,
  type DashboardLayoutItem,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";

/** 目录与默认布局的自洽性 —— 后面所有算法都以此为前提 */
function assertNoOverlap(items: DashboardLayoutItem[]) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      const overlaps =
        a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      expect(overlaps, `${a.id} 与 ${b.id} 不应重叠`).toBe(false);
    }
  }
}

function find(doc: DashboardLayoutDoc, id: DashboardWidgetId) {
  return doc.items.find((item) => item.id === id);
}

function doc(items: DashboardLayoutItem[]): DashboardLayoutDoc {
  return { v: 1, items };
}

describe("卡片目录与默认布局", () => {
  it("默认布局的每一项都在目录内，尺寸合法且互不重叠", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.items).toHaveLength(6);
    assertNoOverlap(DEFAULT_DASHBOARD_LAYOUT.items);

    for (const item of DEFAULT_DASHBOARD_LAYOUT.items) {
      const meta = DASHBOARD_WIDGETS[item.id];
      expect(meta.id).toBe(item.id);
      expect(item.w).toBeGreaterThanOrEqual(meta.minSize.w);
      expect(item.h).toBeGreaterThanOrEqual(meta.minSize.h);
      expect(item.w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(item.x + item.w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(item.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("目录 id 唯一，默认布局没有统计合并卡与单项并存", () => {
    expect(new Set(WIDGET_IDS).size).toBe(WIDGET_IDS.length);
    const ids = new Set(DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.id));
    const hasSummary = ids.has("task_summary");
    const hasStat = STAT_WIDGET_IDS.some((id) => ids.has(id));
    expect(hasSummary && hasStat).toBe(false);
  });
});

describe("normalizeLayoutDoc", () => {
  it("null / 非 v1 / 结构不对都回落默认", () => {
    expect(normalizeLayoutDoc(null)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(normalizeLayoutDoc(undefined)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(normalizeLayoutDoc({ v: 2, items: [] })).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(normalizeLayoutDoc({ v: 1, items: "nope" })).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    expect(normalizeLayoutDoc("nope")).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it("空 items 是用户主动删空，不回落默认", () => {
    expect(normalizeLayoutDoc({ v: 1, items: [] })).toEqual({ v: 1, items: [] });
  });

  it("未知 id 丢弃、重复 id 只留第一份；全脏数据回落默认", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "note", x: 4, y: 0, w: 4, h: 4 },
        { id: "future_widget", x: 8, y: 0, w: 4, h: 4 },
        { id: "clock", x: 0, y: 4, w: 3, h: 2 },
      ],
    });
    expect(normalized.items.map((item) => item.id)).toEqual(["note", "clock"]);

    expect(
      normalizeLayoutDoc({ v: 1, items: [{ id: "future_widget", x: 0, y: 0, w: 4, h: 4 }] }),
    ).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it("越界 / NaN / 浮点被夹取；低于最小尺寸的放大到最小", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "task_board", x: 99, y: -3, w: 2, h: 0 },
        { id: "clock", x: 6.9, y: 5.8, w: Number.NaN, h: Number.POSITIVE_INFINITY },
      ],
    });
    const board = find(normalized, "task_board")!;
    expect(board).toMatchObject({ x: GRID_COLUMNS - DASHBOARD_WIDGETS.task_board.minSize.w, y: 0 });
    expect(board.w).toBe(DASHBOARD_WIDGETS.task_board.minSize.w);
    expect(board.h).toBe(DASHBOARD_WIDGETS.task_board.minSize.h);

    const clock = find(normalized, "clock")!;
    expect(clock.x).toBe(6);
    // 5.8 取整为 5，随后向上压缩（看板缩到最小高度后腾出了位置）
    expect(Number.isInteger(clock.y)).toBe(true);
    expect(clock.y).toBeLessThanOrEqual(5);
    expect(clock.w).toBe(DASHBOARD_WIDGETS.clock.defaultSize.w);
    expect(clock.h).toBe(DASHBOARD_WIDGETS.clock.defaultSize.h);
  });

  it("重叠项被推开，最终布局无重叠", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "clock", x: 0, y: 0, w: 3, h: 2 },
        { id: "quick_links", x: 1, y: 1, w: 3, h: 3 },
      ],
    });
    expect(normalized.items).toHaveLength(3);
    assertNoOverlap(normalized.items);
  });

  it("config 只保留对应卡片允许的字段并截断长度", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", x: 0, y: 0, w: 4, h: 4, config: { text: "字".repeat(800), title: "坏的" } },
        {
          id: "countdown",
          x: 4,
          y: 0,
          w: 3,
          h: 2,
          config: { title: "答".repeat(80), targetAt: "2026-12-31T18:00" },
        },
        { id: "clock", x: 8, y: 0, w: 3, h: 2, config: { text: "不该留下" } },
      ],
    });
    const note = find(normalized, "note")!;
    expect(note.config?.text).toHaveLength(NOTE_MAX_LENGTH);
    expect(note.config?.title).toBeUndefined();

    const countdown = find(normalized, "countdown")!;
    expect(countdown.config?.title).toHaveLength(COUNTDOWN_TITLE_MAX_LENGTH);
    expect(countdown.config?.targetAt).toBe("2026-12-31T18:00");

    expect(find(normalized, "clock")!.config).toBeUndefined();
  });

  it("倒计时目标格式不对就丢弃", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        {
          id: "countdown",
          x: 0,
          y: 0,
          w: 3,
          h: 2,
          config: { title: "交稿", targetAt: "2026/12/31 18:00" },
        },
      ],
    });
    expect(find(normalized, "countdown")!.config).toEqual({ title: "交稿" });
  });

  it("统计合并卡与四项同时存在时保留合并卡", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "task_summary", x: 0, y: 0, w: 8, h: 2 },
        { id: "stat_overdue", x: 0, y: 2, w: 3, h: 2 },
        { id: "stat_today", x: 3, y: 2, w: 3, h: 2 },
      ],
    });
    expect(normalized.items.map((item) => item.id)).toEqual(["task_summary"]);
  });
});

describe("moveWidget", () => {
  it("拖到空位：目标占住新格子，原位置被压缩掉", () => {
    const moved = moveWidget(DEFAULT_DASHBOARD_LAYOUT, "clock", 0, 0);
    // 默认布局里没有 clock，不应有任何变化
    expect(moved).toBe(DEFAULT_DASHBOARD_LAYOUT);

    const withClock = addWidget(DEFAULT_DASHBOARD_LAYOUT, "clock");
    const movedClock = moveWidget(withClock, "clock", 8, 0);
    expect(find(movedClock, "clock")).toMatchObject({ x: 8, y: 0, w: 3, h: 2 });
    assertNoOverlap(movedClock.items);
  });

  it("拖到别人头上：目标优先，旧卡下移（含级联）", () => {
    const moved = moveWidget(DEFAULT_DASHBOARD_LAYOUT, "activity_feed", 0, 2);
    expect(find(moved, "activity_feed")).toMatchObject({ x: 0, y: 2 });
    const board = find(moved, "task_board")!;
    const feed = find(moved, "activity_feed")!;
    // 看板被推到动态流下方；动态流（默认 4 行）从 y=2 开始
    expect(board.y).toBeGreaterThanOrEqual(feed.y + feed.h);
    assertNoOverlap(moved.items);
  });

  it("越界坐标被夹回网格", () => {
    const moved = moveWidget(DEFAULT_DASHBOARD_LAYOUT, "activity_feed", -10, -10);
    const feed = find(moved, "activity_feed")!;
    expect(feed.x).toBe(0);
    expect(feed.y).toBe(0);
    expect(feed.x + feed.w).toBeLessThanOrEqual(GRID_COLUMNS);

    const right = moveWidget(DEFAULT_DASHBOARD_LAYOUT, "activity_feed", 99, 2);
    const rightFeed = find(right, "activity_feed")!;
    expect(rightFeed.x).toBe(GRID_COLUMNS - rightFeed.w);
  });
});

describe("resizeWidget", () => {
  it("不低于最小尺寸", () => {
    const resized = resizeWidget(DEFAULT_DASHBOARD_LAYOUT, "task_board", 1, 1);
    const board = find(resized, "task_board")!;
    expect(board.w).toBe(DASHBOARD_WIDGETS.task_board.minSize.w);
    expect(board.h).toBe(DASHBOARD_WIDGETS.task_board.minSize.h);
  });

  it("不超过右边界，并把下方卡片推开", () => {
    const resized = resizeWidget(DEFAULT_DASHBOARD_LAYOUT, "task_board", 20, 7);
    const board = find(resized, "task_board")!;
    expect(board.w).toBe(GRID_COLUMNS);

    const feed = find(resized, "activity_feed")!;
    expect(feed.y).toBeGreaterThanOrEqual(board.y + board.h);
    assertNoOverlap(resized.items);
  });
});

describe("addWidget / removeWidget", () => {
  it("重复添加原样返回", () => {
    expect(addWidget(DEFAULT_DASHBOARD_LAYOUT, "task_board")).toBe(DEFAULT_DASHBOARD_LAYOUT);
  });

  it("新卡追加在内容下方，默认尺寸", () => {
    const added = addWidget(DEFAULT_DASHBOARD_LAYOUT, "clock");
    const clock = find(added, "clock")!;
    expect(clock).toMatchObject({ x: 0, w: 3, h: 2 });
    expect(clock.y).toBeGreaterThanOrEqual(9);
    assertNoOverlap(added.items);
  });

  it("删卡后向上压缩", () => {
    const withClock = addWidget(DEFAULT_DASHBOARD_LAYOUT, "clock");
    const before = find(withClock, "clock")!;
    const removed = removeWidget(withClock, "task_board");
    const after = find(removed, "clock")!;
    expect(after.y).toBeLessThan(before.y);
    assertNoOverlap(removed.items);
  });

  it("加合并概览会移除四张单项；加单项会移除合并卡", () => {
    const summary = addWidget(DEFAULT_DASHBOARD_LAYOUT, "task_summary");
    expect(find(summary, "task_summary")).toBeDefined();
    expect(STAT_WIDGET_IDS.some((id) => find(summary, id))).toBe(false);

    const oneStat = addWidget(
      doc([{ id: "task_summary", x: 0, y: 0, w: 8, h: 2 }]),
      "stat_today",
    );
    expect(find(oneStat, "task_summary")).toBeUndefined();
    expect(find(oneStat, "stat_today")).toMatchObject({ x: 0, y: 0 });
  });

  it("删除不存在的卡原样返回", () => {
    expect(removeWidget(DEFAULT_DASHBOARD_LAYOUT, "clock")).toBe(DEFAULT_DASHBOARD_LAYOUT);
  });
});

describe("配置与顺序", () => {
  it("updateWidgetConfig 不改变位置，并截断过长文本", () => {
    const withNote = addWidget(DEFAULT_DASHBOARD_LAYOUT, "note");
    const updated = updateWidgetConfig(withNote, "note", { text: "字".repeat(700) });
    const before = find(withNote, "note")!;
    const after = find(updated, "note")!;
    expect(after).toMatchObject({ x: before.x, y: before.y, w: before.w, h: before.h });
    expect(after.config?.text).toHaveLength(NOTE_MAX_LENGTH);
  });

  it("给不支持配置的卡片写 config 会被丢弃", () => {
    const updated = updateWidgetConfig(DEFAULT_DASHBOARD_LAYOUT, "clock", { text: "x" });
    expect(find(updated, "clock")).toBeUndefined(); // 默认没有 clock
    const withClock = addWidget(DEFAULT_DASHBOARD_LAYOUT, "clock");
    expect(find(updateWidgetConfig(withClock, "clock", { text: "x" }), "clock")!.config).toBeUndefined();
  });

  it("widgetOrder 与 sortByCatalog", () => {
    expect(widgetOrder({ x: 0, y: 0 })).toBe(0);
    expect(widgetOrder({ x: 3, y: 2 })).toBe(27);

    const shuffled = doc([
      { id: "clock", x: 0, y: 0, w: 3, h: 2 },
      { id: "task_board", x: 0, y: 2, w: 8, h: 7 },
    ]);
    expect(sortByCatalog(shuffled).map((item) => item.id)).toEqual(["task_board", "clock"]);
  });
});
