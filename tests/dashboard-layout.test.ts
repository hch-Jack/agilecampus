import { describe, it, expect } from "vitest";
import {
  CLOCK_MAX_ZONES,
  COUNTDOWN_TITLE_MAX_LENGTH,
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_LAYOUT,
  GRID_COLUMNS,
  NOTE_MAX_LENGTH,
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

function find(doc: DashboardLayoutDoc, id: string) {
  return doc.items.find((item) => item.id === id);
}

function doc(items: DashboardLayoutItem[]): DashboardLayoutDoc {
  return { v: 1, items };
}

describe("卡片目录与默认布局", () => {
  it("默认布局覆盖全部卡片，尺寸合法且互不重叠", () => {
    expect(DEFAULT_DASHBOARD_LAYOUT.items).toHaveLength(WIDGET_IDS.length);
    expect(DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.type).sort()).toEqual(
      [...WIDGET_IDS].sort(),
    );
    assertNoOverlap(DEFAULT_DASHBOARD_LAYOUT.items);

    for (const item of DEFAULT_DASHBOARD_LAYOUT.items) {
      const meta = DASHBOARD_WIDGETS[item.type];
      expect(meta.id).toBe(item.type);
      expect(item.w).toBeGreaterThanOrEqual(meta.minSize.w);
      expect(item.h).toBeGreaterThanOrEqual(meta.minSize.h);
      expect(item.w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(item.x + item.w).toBeLessThanOrEqual(GRID_COLUMNS);
      expect(item.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("目录 id 唯一，默认布局里只有单例卡", () => {
    expect(new Set(WIDGET_IDS).size).toBe(WIDGET_IDS.length);
    const types = DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.type);
    expect(new Set(types).size).toBe(types.length);
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

  it("旧版布局只有 id、没有 type：按 id 回填类型", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "clock", x: 0, y: 4, w: 3, h: 2 },
      ],
    });
    expect(normalized.items).toEqual([
      { id: "note", type: "note", x: 0, y: 0, w: 4, h: 4 },
      { id: "clock", type: "clock", x: 0, y: 4, w: 3, h: 2 },
    ]);
  });

  it("未知类型丢弃、重复实例 id 只留第一份；全脏数据回落默认", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", type: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "note", type: "note", x: 4, y: 0, w: 4, h: 4 },
        { id: "future_widget", x: 8, y: 0, w: 4, h: 4 },
        { id: "clock", type: "clock", x: 0, y: 4, w: 3, h: 2 },
      ],
    });
    expect(normalized.items.map((item) => item.id)).toEqual(["note", "clock"]);

    expect(
      normalizeLayoutDoc({ v: 1, items: [{ id: "future_widget", x: 0, y: 0, w: 4, h: 4 }] }),
    ).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it("可重复卡允许多实例，单例卡同类型只留第一张", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", type: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "note-2", type: "note", x: 4, y: 0, w: 4, h: 4 },
        { id: "clock", type: "clock", x: 0, y: 4, w: 3, h: 2 },
        { id: "clock-2", type: "clock", x: 3, y: 4, w: 3, h: 2 },
        { id: "quick_links", type: "quick_links", x: 0, y: 6, w: 3, h: 3 },
        { id: "quick_links-2", type: "quick_links", x: 3, y: 6, w: 3, h: 3 },
      ],
    });
    expect(normalized.items.map((item) => item.id)).toEqual([
      "note",
      "note-2",
      "clock",
      "clock-2",
      "quick_links",
    ]);
  });

  it("越界 / NaN / 浮点被夹取；低于最小尺寸的放大到最小", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "task_board", x: 99, y: -3, w: 2, h: 0 },
        { id: "clock", type: "clock", x: 6.9, y: 5.8, w: Number.NaN, h: Number.POSITIVE_INFINITY },
      ],
    });
    const board = find(normalized, "task_board")!;
    expect(board).toMatchObject({ x: GRID_COLUMNS - DASHBOARD_WIDGETS.task_board.minSize.w, y: 0 });
    expect(board.w).toBe(DASHBOARD_WIDGETS.task_board.minSize.w);
    expect(board.h).toBe(DASHBOARD_WIDGETS.task_board.minSize.h);

    const clock = find(normalized, "clock")!;
    expect(clock.x).toBe(6);
    // 5.8 取整为 5；布局不做自动回填，坐标原样保留
    expect(clock.y).toBe(5);
    expect(clock.w).toBe(DASHBOARD_WIDGETS.clock.defaultSize.w);
    expect(clock.h).toBe(DASHBOARD_WIDGETS.clock.defaultSize.h);
  });

  it("重叠项被推开，最终布局无重叠", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", type: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "clock", type: "clock", x: 0, y: 0, w: 3, h: 2 },
        { id: "quick_links", type: "quick_links", x: 1, y: 1, w: 3, h: 3 },
      ],
    });
    expect(normalized.items).toHaveLength(3);
    assertNoOverlap(normalized.items);
  });

  it("config 只保留对应卡片允许的字段并截断长度", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        { id: "note", type: "note", x: 0, y: 0, w: 4, h: 4, config: { text: "字".repeat(800), title: "坏的" } },
        {
          id: "countdown",
          type: "countdown",
          x: 4,
          y: 0,
          w: 3,
          h: 3,
          config: { title: "答".repeat(80), targetAt: "2026-12-31T18:00" },
        },
        { id: "clock", type: "clock", x: 8, y: 0, w: 3, h: 2, config: { text: "不该留下" } },
      ],
    });
    const note = find(normalized, "note")!;
    expect(note.config?.text).toHaveLength(NOTE_MAX_LENGTH);
    expect(note.config?.title).toBeUndefined();

    const countdown = find(normalized, "countdown")!;
    expect(countdown.config?.title).toHaveLength(COUNTDOWN_TITLE_MAX_LENGTH);
    expect(countdown.config?.targetAt).toBe("2026-12-31T18:00");

    // 时钟只认 lunar / zones；无关字段丢弃后整个 config 也不留
    expect(find(normalized, "clock")!.config).toBeUndefined();
  });

  it("时钟配置：农历 + 世界时钟去重、限量、丢弃非法时区", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        {
          id: "clock",
          type: "clock",
          x: 0,
          y: 0,
          w: 4,
          h: 3,
          config: {
            lunar: true,
            zones: [
              "Asia/Shanghai",
              "Asia/Shanghai",
              "Europe/London",
              "America/New_York",
              "Australia/Sydney",
              "not a zone!",
            ],
          },
        },
      ],
    });
    const config = find(normalized, "clock")!.config!;
    expect(config.lunar).toBe(true);
    expect(config.zones).toEqual(["Asia/Shanghai", "Europe/London", "America/New_York"]);
    expect(config.zones).toHaveLength(CLOCK_MAX_ZONES);
  });

  it("倒计时目标格式不对就丢弃", () => {
    const normalized = normalizeLayoutDoc({
      v: 1,
      items: [
        {
          id: "countdown",
          type: "countdown",
          x: 0,
          y: 0,
          w: 3,
          h: 3,
          config: { title: "交稿", targetAt: "2026/12/31 18:00" },
        },
      ],
    });
    expect(find(normalized, "countdown")!.config).toEqual({ title: "交稿" });
  });
});

describe("moveWidget", () => {
  it("拖到空位：目标占住新格子，其他卡片不动", () => {
    // 不存在的实例 id：原样返回
    expect(moveWidget(DEFAULT_DASHBOARD_LAYOUT, "nope", 0, 0)).toBe(
      DEFAULT_DASHBOARD_LAYOUT,
    );

    const moved = moveWidget(DEFAULT_DASHBOARD_LAYOUT, "activity_feed", 8, 23);
    expect(find(moved, "activity_feed")).toMatchObject({ x: 8, y: 23 });
    expect(find(moved, "task_board")).toMatchObject({ x: 0, y: 2 });
    assertNoOverlap(moved.items);
  });

  it("可以留白：往下方拖不会被自动吸回", () => {
    const moved = moveWidget(DEFAULT_DASHBOARD_LAYOUT, "activity_feed", 0, 24);
    const feed = find(moved, "activity_feed")!;
    expect(feed).toMatchObject({ x: 0, y: 24 });
    // 其他卡片原地不动，中间的空行保留
    expect(find(moved, "task_board")).toMatchObject({ x: 0, y: 2 });
    assertNoOverlap(moved.items);
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

  it("可重复卡按实例 id 移动，兄弟实例不动", () => {
    let layout = addWidget(DEFAULT_DASHBOARD_LAYOUT, "note");
    layout = addWidget(layout, "note");
    const first = find(layout, "note")!;
    const second = find(layout, "note-2")!;
    const moved = moveWidget(layout, "note-2", 8, second.y);
    expect(find(moved, "note")).toMatchObject({ x: first.x, y: first.y });
    expect(find(moved, "note-2")!.x).toBe(8);
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
  it("单例卡重复添加原样返回", () => {
    expect(addWidget(DEFAULT_DASHBOARD_LAYOUT, "task_board")).toBe(DEFAULT_DASHBOARD_LAYOUT);
    expect(addWidget(DEFAULT_DASHBOARD_LAYOUT, "schedule")).toBe(DEFAULT_DASHBOARD_LAYOUT);
  });

  it("新卡追加在内容下方，默认尺寸", () => {
    const bottom = Math.max(
      ...DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.y + item.h),
    );
    const added = addWidget(DEFAULT_DASHBOARD_LAYOUT, "note");
    const note = find(added, "note-2")!;
    expect(note).toMatchObject({ id: "note-2", type: "note", x: 0, w: 4, h: 4 });
    expect(note.y).toBe(bottom);
    assertNoOverlap(added.items);
  });

  it("便签 / 时钟 / 倒计时可以重复添加，实例 id 递增", () => {
    let layout = addWidget(DEFAULT_DASHBOARD_LAYOUT, "note");
    layout = addWidget(layout, "note");
    layout = addWidget(layout, "note");
    expect(layout.items.filter((item) => item.type === "note").map((item) => item.id)).toEqual([
      "note",
      "note-2",
      "note-3",
      "note-4",
    ]);
    expect(new Set(layout.items.map((item) => item.id)).size).toBe(layout.items.length);
    assertNoOverlap(layout.items);

    // 先删掉默认那张，才能验证可重复卡的第二实例
    const withoutClock = removeWidget(DEFAULT_DASHBOARD_LAYOUT, "clock");
    const clock = addWidget(withoutClock, "clock");
    const clock2 = addWidget(clock, "clock");
    expect(clock2.items.filter((item) => item.type === "clock")).toHaveLength(2);
  });

  it("删卡按实例 id，不牵动其他卡片（留白由用户自己决定）", () => {
    const withNote = addWidget(DEFAULT_DASHBOARD_LAYOUT, "note");
    const before = find(withNote, "note-2")!;
    const removed = removeWidget(withNote, "task_board");
    const after = find(removed, "note-2")!;
    expect(after.y).toBe(before.y);
    assertNoOverlap(removed.items);
  });

  it("删除不存在的卡原样返回", () => {
    expect(removeWidget(DEFAULT_DASHBOARD_LAYOUT, "nope")).toBe(DEFAULT_DASHBOARD_LAYOUT);
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

  it("同一类型的多个实例各存各的配置", () => {
    let layout = addWidget(DEFAULT_DASHBOARD_LAYOUT, "note");
    layout = addWidget(layout, "note");
    layout = updateWidgetConfig(layout, "note", { text: "第一张" });
    layout = updateWidgetConfig(layout, "note-2", { text: "第二张" });
    expect(find(layout, "note")!.config?.text).toBe("第一张");
    expect(find(layout, "note-2")!.config?.text).toBe("第二张");
  });

  it("时钟可以保存农历与世界时钟；清空后也保留空配置", () => {
    const withClock = addWidget(DEFAULT_DASHBOARD_LAYOUT, "clock");
    const updated = updateWidgetConfig(withClock, "clock", {
      lunar: true,
      zones: ["Asia/Tokyo"],
    });
    expect(find(updated, "clock")!.config).toEqual({ lunar: true, zones: ["Asia/Tokyo"] });

    const cleared = updateWidgetConfig(updated, "clock", { lunar: false, zones: [] });
    expect(find(cleared, "clock")!.config).toEqual({ lunar: false, zones: [] });
  });

  it("给不支持配置的卡片写 config 会被丢弃", () => {
    const updated = updateWidgetConfig(DEFAULT_DASHBOARD_LAYOUT, "clock", { text: "x" });
    expect(find(updated, "clock")!.config).toBeUndefined();
    expect(find(updated, "clock")).toMatchObject({ x: 0, y: 20, w: 4, h: 3 });
  });

  it("widgetOrder 与 sortByCatalog", () => {
    expect(widgetOrder({ x: 0, y: 0 })).toBe(0);
    expect(widgetOrder({ x: 3, y: 2 })).toBe(27);

    const shuffled = doc([
      { id: "clock", type: "clock", x: 0, y: 0, w: 4, h: 3 },
      { id: "task_board", type: "task_board", x: 0, y: 2, w: 8, h: 7 },
      { id: "note-2", type: "note", x: 0, y: 9, w: 4, h: 4 },
    ]);
    expect(sortByCatalog(shuffled).map((item) => item.id)).toEqual([
      "task_board",
      "note-2",
      "clock",
    ]);
  });
});

describe("新增卡片在目录内", () => {
  it("里程碑 / 资源占用 / 最近附件 / 专注计时都有目录项与默认尺寸", () => {
    const types: DashboardWidgetId[] = [
      "milestones",
      "resource_usage",
      "recent_attachments",
      "focus_timer",
    ];
    for (const type of types) {
      const meta = DASHBOARD_WIDGETS[type];
      expect(meta.id).toBe(type);
      expect(meta.defaultSize.w).toBeGreaterThanOrEqual(meta.minSize.w);
      expect(meta.defaultSize.h).toBeGreaterThanOrEqual(meta.minSize.h);
    }
  });

  it("「任务概览（四合一）」已下线", () => {
    expect(WIDGET_IDS as readonly string[]).not.toContain("task_summary");
  });
});
