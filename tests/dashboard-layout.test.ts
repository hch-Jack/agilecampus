import { describe, it, expect } from "vitest";
import {
  CLOCK_MAX_ZONES,
  COUNTDOWN_TITLE_MAX_LENGTH,
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_LAYOUT,
  DEFAULT_RAIL_LAYOUT,
  GRID_COLUMNS,
  GRID_GAP,
  GRID_ROW_HEIGHT,
  NOTE_MAX_LENGTH,
  SCHEDULE_GANTT_RATIO_MAX,
  SCHEDULE_POOL_RATIO_MIN,
  WIDGET_IDS,
  ZOOM_MAX,
  ZOOM_MIN,
  addWidget,
  addWidgetFullWidth,
  moveWidget,
  normalizeLayoutDoc,
  normalizeZoom,
  defaultDashboardLayoutFor,
  defaultRailLayoutFor,
  gridMetrics,
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
    // 待办审批卡不在通用默认里：它面向老师/管理员，由 defaultDashboardLayoutFor(true)
    // 追加（学生拿了恒为空态，没意义）。这里对通用默认排除它，另测审批人默认。
    const nonApproverIds = WIDGET_IDS.filter((id) => id !== "approvals");
    expect(DEFAULT_DASHBOARD_LAYOUT.items).toHaveLength(nonApproverIds.length);
    expect(DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.type).sort()).toEqual(
      [...nonApproverIds].sort(),
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

  it("看板默认铺满整行、比初版高一格，辅助卡按使用频率分三排", () => {
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "task_board")).toMatchObject({
      x: 0,
      y: 2,
      w: GRID_COLUMNS,
      h: 7,
    });
    // 消息卡的四个瓦片要放得下大号数字：给到 3 行高，与活动流对调一行
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "unread_messages")).toMatchObject({ y: 12, h: 3 });
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "activity_feed")).toMatchObject({ y: 9, h: 3 });
    // 要盯的卡片在第一排，随手用的小工具压在最底
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "upcoming")).toMatchObject({ y: 18 });
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "milestones")).toMatchObject({ y: 18 });
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "resource_usage")).toMatchObject({ y: 18 });
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "clock")).toMatchObject({ y: 24 });
    expect(find(DEFAULT_DASHBOARD_LAYOUT, "countdown")).toMatchObject({ y: 24 });
  });

  it("目录 id 唯一，默认布局里只有单例卡", () => {
    expect(new Set(WIDGET_IDS).size).toBe(WIDGET_IDS.length);
    const types = DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("审批人默认布局 = 通用默认 + 待办审批卡，且不与任何卡重叠", () => {
    const approverDoc = defaultDashboardLayoutFor(true);
    expect(approverDoc.items).toHaveLength(WIDGET_IDS.length);
    expect(approverDoc.items.map((item) => item.type).sort()).toEqual([...WIDGET_IDS].sort());
    expect(approverDoc.items.find((item) => item.type === "approvals")).toBeDefined();
    assertNoOverlap(approverDoc.items);
    expect(defaultDashboardLayoutFor(false)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });

  it("审批人的待办审批卡占据「我的项目」原位置，我的项目顺延到下面", () => {
    const approverDoc = defaultDashboardLayoutFor(true);
    const oldProjectSlot = DEFAULT_DASHBOARD_LAYOUT.items.find(
      (item) => item.type === "my_projects",
    );
    const approvalsItem = approverDoc.items.find((item) => item.type === "approvals");
    const projectItem = approverDoc.items.find((item) => item.type === "my_projects");
    expect(oldProjectSlot).toBeDefined();
    expect(approvalsItem).toBeDefined();
    expect(projectItem).toBeDefined();
    expect({ x: approvalsItem!.x, y: approvalsItem!.y }).toEqual({
      x: oldProjectSlot!.x,
      y: oldProjectSlot!.y,
    });
    expect(projectItem!.y).toBeGreaterThan(approvalsItem!.y);
  });

  it("恢复默认的归一化链路不吞掉审批人的待办审批卡", () => {
    // 编辑模式「恢复默认」= normalizeLayoutDoc(defaultDashboardLayoutFor(isApprover))
    const approverDoc = normalizeLayoutDoc(defaultDashboardLayoutFor(true));
    expect(approverDoc.items.map((item) => item.type)).toContain("approvals");
    expect(normalizeLayoutDoc(defaultDashboardLayoutFor(false))).toEqual(DEFAULT_DASHBOARD_LAYOUT);
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

  it("日程表：模块开关与分区比例可保存，越界比例被夹取", () => {
    const hidden = updateWidgetConfig(DEFAULT_DASHBOARD_LAYOUT, "schedule", {
      showGantt: false,
      showPool: true,
      showCalendar: false,
      ganttRatio: 0.62,
      poolRatio: 0.33,
    });
    expect(find(hidden, "schedule")!.config).toEqual({
      showGantt: false,
      showPool: true,
      showCalendar: false,
      ganttRatio: 0.62,
      poolRatio: 0.33,
    });

    const clamped = updateWidgetConfig(DEFAULT_DASHBOARD_LAYOUT, "schedule", {
      ganttRatio: 5,
      poolRatio: 0,
    });
    expect(find(clamped, "schedule")!.config).toEqual({
      ganttRatio: SCHEDULE_GANTT_RATIO_MAX,
      poolRatio: SCHEDULE_POOL_RATIO_MIN,
    });

    // 别的卡不认这些字段
    const wrongCard = updateWidgetConfig(DEFAULT_DASHBOARD_LAYOUT, "task_board", {
      showGantt: false,
    });
    expect(find(wrongCard, "task_board")!.config).toBeUndefined();
  });

  it("给不支持配置的卡片写 config 会被丢弃", () => {
    const before = find(DEFAULT_DASHBOARD_LAYOUT, "clock")!;
    const updated = updateWidgetConfig(DEFAULT_DASHBOARD_LAYOUT, "clock", { text: "x" });
    expect(find(updated, "clock")!.config).toBeUndefined();
    // 位置与尺寸原样保留（默认版式会调整，这里只验证 config 不牵动几何）
    expect(find(updated, "clock")).toMatchObject(before);
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

describe("缩放", () => {
  it("normalizeZoom：非法值丢弃、越界夹取、按 0.1 取整、1 视为缺省", () => {
    expect(normalizeZoom(undefined)).toBeUndefined();
    expect(normalizeZoom("1.2")).toBeUndefined();
    expect(normalizeZoom(Number.NaN)).toBeUndefined();
    expect(normalizeZoom(1)).toBeUndefined();
    expect(normalizeZoom(0.99)).toBeUndefined(); // 取整后是 1
    expect(normalizeZoom(0.2)).toBe(ZOOM_MIN);
    expect(normalizeZoom(9)).toBe(ZOOM_MAX);
    expect(normalizeZoom(1.24)).toBe(1.2);
    expect(normalizeZoom(0.74)).toBe(0.7); // 舍入到一位小数
  });

  it("gridMetrics：缩放只改行高与间距，列数恒为 12", () => {
    expect(gridMetrics(undefined)).toEqual({ rowHeight: GRID_ROW_HEIGHT, gap: GRID_GAP });
    expect(gridMetrics(1)).toEqual({ rowHeight: GRID_ROW_HEIGHT, gap: GRID_GAP });
    expect(gridMetrics(0.7)).toEqual({
      rowHeight: Math.round(GRID_ROW_HEIGHT * 0.7),
      gap: Math.round(GRID_GAP * 0.7),
    });
    expect(gridMetrics(1.5)).toEqual({
      rowHeight: Math.round(GRID_ROW_HEIGHT * 1.5),
      gap: Math.round(GRID_GAP * 1.5),
    });
    // 底部兜底：再小的缩放也不会把格子压成 0/负
    expect(gridMetrics(ZOOM_MIN).rowHeight).toBeGreaterThanOrEqual(16);
    expect(gridMetrics(ZOOM_MIN).gap).toBeGreaterThanOrEqual(4);
  });

  it("normalizeLayoutDoc 保留 zoom，缺省与非法值都不带字段", () => {
    const base = { v: 1, items: [{ id: "clock", x: 0, y: 0, w: 3, h: 2 }] };
    expect(normalizeLayoutDoc({ ...base, zoom: 1.3 }).zoom).toBe(1.3);
    expect(normalizeLayoutDoc({ ...base, zoom: 0.4 }).zoom).toBe(ZOOM_MIN);
    expect(normalizeLayoutDoc({ ...base, zoom: 9 }).zoom).toBe(ZOOM_MAX);
    expect(normalizeLayoutDoc({ ...base, zoom: 1 })).not.toHaveProperty("zoom");
    expect(normalizeLayoutDoc(base)).not.toHaveProperty("zoom");
    expect(normalizeLayoutDoc({ ...base, zoom: "1.2" })).not.toHaveProperty("zoom");
    expect(normalizeLayoutDoc({ v: 1, items: [], zoom: 1.2 })).toEqual({
      v: 1,
      items: [],
      zoom: 1.2,
    });
  });

  it("所有布局变更都保留 zoom", () => {
    const doc = { ...DEFAULT_DASHBOARD_LAYOUT, zoom: 1.2 };
    expect(moveWidget(doc, "activity_feed", 0, 30).zoom).toBe(1.2);
    expect(resizeWidget(doc, "task_board", 12, 8).zoom).toBe(1.2);
    expect(addWidget(doc, "note").zoom).toBe(1.2);
    expect(removeWidget(doc, "clock").zoom).toBe(1.2);
    expect(updateWidgetConfig(doc, "note", { text: "x" }).zoom).toBe(1.2);
    expect(addWidgetFullWidth(doc, "note").zoom).toBe(1.2);
  });
});

describe("常驻栏默认布局", () => {
  it("卡片都在 12 列内、满宽、满足最小尺寸且互不重叠", () => {
    expect(DEFAULT_RAIL_LAYOUT.items.length).toBeGreaterThan(0);
    assertNoOverlap(DEFAULT_RAIL_LAYOUT.items);
    for (const item of DEFAULT_RAIL_LAYOUT.items) {
      const meta = DASHBOARD_WIDGETS[item.type];
      expect(item.x).toBe(0);
      expect(item.w).toBe(GRID_COLUMNS);
      expect(item.h).toBeGreaterThanOrEqual(meta.minSize.h);
    }
  });

  it("归一化不改动默认常驻栏（顺序按位置排）", () => {
    expect(normalizeLayoutDoc(DEFAULT_RAIL_LAYOUT)).toEqual(DEFAULT_RAIL_LAYOUT);
  });

  it("审批人默认在顶部多一张待办审批，其余整体下移且不重叠", () => {
    const approver = defaultRailLayoutFor(true);
    const first = approver.items[0];
    expect(first).toMatchObject({ id: "approvals", type: "approvals", x: 0, w: GRID_COLUMNS });
    expect(approver.items).toHaveLength(DEFAULT_RAIL_LAYOUT.items.length + 1);
    assertNoOverlap(approver.items);
    expect(normalizeLayoutDoc(approver)).toEqual(approver);
    expect(defaultRailLayoutFor(false)).toEqual(DEFAULT_RAIL_LAYOUT);
  });
});

describe("addWidgetFullWidth", () => {
  it("新卡追加到内容下方并拉满整行", () => {
    const bottom = Math.max(...DEFAULT_DASHBOARD_LAYOUT.items.map((item) => item.y + item.h));
    const added = addWidgetFullWidth(DEFAULT_DASHBOARD_LAYOUT, "note");
    const note = find(added, "note-2")!;
    expect(note).toMatchObject({ type: "note", x: 0, y: bottom, w: GRID_COLUMNS });
    expect(note.h).toBe(DASHBOARD_WIDGETS.note.defaultSize.h);
    assertNoOverlap(added.items);
  });

  it("单例卡已存在时原样返回（不重复添加）", () => {
    expect(addWidgetFullWidth(DEFAULT_DASHBOARD_LAYOUT, "task_board")).toBe(
      DEFAULT_DASHBOARD_LAYOUT,
    );
  });
});
