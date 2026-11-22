import { describe, expect, it } from "vitest";
import {
  buildBurndownSeries,
  computePace,
  type BurndownEvent,
} from "@/lib/burndown";

const e = (day: string, kind: BurndownEvent["kind"]): BurndownEvent => ({ day, kind });

describe("buildBurndownSeries：重放与阶梯", () => {
  it("创建→完成→重开：剩余随事件升降，总规模只增", () => {
    const { points, ideal } = buildBurndownSeries({
      events: [
        e("2026-11-01", "created"),
        e("2026-11-01", "created"),
        e("2026-11-03", "done"),
        e("2026-11-05", "reopened"),
        e("2026-11-06", "done"),
      ],
      window: { start: "2026-11-01", end: "2026-11-07" },
      anchors: { totalNow: 2, remainingNow: 1 },
      deadline: null,
    });
    expect(ideal).toEqual([]);
    const byDay = Object.fromEntries(points.map((p) => [p.day, p]));
    expect(byDay["2026-11-01"]).toMatchObject({ remaining: 2, total: 2 });
    expect(byDay["2026-11-02"]).toMatchObject({ remaining: 2, total: 2 }); // 无事件日走平
    expect(byDay["2026-11-03"]).toMatchObject({ remaining: 1, total: 2 });
    expect(byDay["2026-11-05"]).toMatchObject({ remaining: 2, total: 2 }); // 重开回升
    expect(byDay["2026-11-06"]).toMatchObject({ remaining: 1, total: 2 });
    expect(points[points.length - 1].day).toBe("2026-11-07");
  });

  it("末端校正：动态缺失的存量项目，整条曲线平移到与看板一致", () => {
    // 只有 1 条 created 动态，但库里实际有 5 个任务、剩 3 个（其余动态丢了）
    const { points } = buildBurndownSeries({
      events: [e("2026-11-01", "created")],
      window: { start: "2026-11-01", end: "2026-11-02" },
      anchors: { totalNow: 5, remainingNow: 3 },
      deadline: null,
    });
    expect(points[0]).toMatchObject({ remaining: 3, total: 5 });
    expect(points[1]).toMatchObject({ remaining: 3, total: 5 });
  });

  it("窗口起点早于首事件：前段走平，不出现负数", () => {
    const { points } = buildBurndownSeries({
      events: [e("2026-11-04", "created")],
      window: { start: "2026-11-01", end: "2026-11-04" },
      anchors: { totalNow: 1, remainingNow: 0 },
      deadline: null,
    });
    expect(points[0]).toMatchObject({ remaining: 0, total: 0 });
    expect(points[3]).toMatchObject({ remaining: 0, total: 1 }); // 当天已完成
  });
});

describe("buildBurndownSeries：阶梯理想线（按任务截止日）", () => {
  it("各任务按各自 dueDate 下台阶；已逾期的挪到明天", () => {
    const { ideal, points } = buildBurndownSeries({
      events: [e("2026-11-01", "created"), e("2026-11-01", "created"), e("2026-11-01", "created")],
      window: { start: "2026-11-01", end: "2026-11-10" },
      anchors: { totalNow: 3, remainingNow: 3 },
      deadline: "2026-11-12",
      todayDay: "2026-11-10",
      remainingDues: ["2026-11-05", "2026-11-11", "2026-11-20"], // 一个已逾期、一个超截止日
      noDueRemaining: 0,
    });
    // 视界 = max(截止日, 最晚 dueDate) = 11-20，窗口随之右延
    expect(points[points.length - 1].day).toBe("2026-11-20");
    const byDay = Object.fromEntries(ideal.map((p) => [p.day, p.value]));
    expect(byDay["2026-11-10"]).toBe(3); // 今天锚定
    expect(byDay["2026-11-11"]).toBe(1); // 逾期的（原 11-05 挪到明天）与 11-11 的同日下两阶
    expect(byDay["2026-11-20"]).toBe(0); // 超截止日的任务在其 dueDate 归零
  });

  it("无 dueDate 的任务在 [今天, 视界] 线性均摊（小数）", () => {
    const { ideal } = buildBurndownSeries({
      events: [e("2026-11-01", "created"), e("2026-11-01", "created")],
      window: { start: "2026-11-01", end: "2026-11-10" },
      anchors: { totalNow: 2, remainingNow: 2 },
      deadline: "2026-11-14",
      todayDay: "2026-11-10",
      remainingDues: ["2026-11-12"],
      noDueRemaining: 1,
    });
    const byDay = Object.fromEntries(ideal.map((p) => [p.day, p.value]));
    expect(byDay["2026-11-10"]).toBe(2);
    expect(byDay["2026-11-11"]).toBeCloseTo(1.75, 6); // 均摊 0.25/天
    expect(byDay["2026-11-12"]).toBeCloseTo(0.5, 6); // dueDate 台阶 + 均摊
    expect(byDay["2026-11-14"]).toBe(0);
  });

  it("不画线的边界：剩余为 0、无截止且无排期、视界就是今天", () => {
    const base = {
      events: [e("2026-11-01", "created"), e("2026-11-02", "done")],
      window: { start: "2026-11-01", end: "2026-11-05" },
      todayDay: "2026-11-05",
    };
    // 剩余已归零
    expect(
      buildBurndownSeries({ ...base, anchors: { totalNow: 1, remainingNow: 0 }, deadline: "2026-11-09" }).ideal,
    ).toEqual([]);
    // 无截止日且剩余任务都没有排期
    expect(
      buildBurndownSeries({
        ...base,
        anchors: { totalNow: 2, remainingNow: 1 },
        deadline: null,
        remainingDues: [],
        noDueRemaining: 1,
      }).ideal,
    ).toEqual([]);
    // 截止日就是今天且任务无排期 → 视界 ≤ 今天
    expect(
      buildBurndownSeries({
        ...base,
        anchors: { totalNow: 2, remainingNow: 1 },
        deadline: "2026-11-05",
        remainingDues: [],
        noDueRemaining: 1,
      }).ideal,
    ).toEqual([]);
  });
});

describe("computePace：吞吐预测", () => {
  it("近 14 天净完成速率外推完成日", () => {
    // 14 天窗口 [10-28, 11-10]：完成 7 个 → 0.5/天；剩 4 → 8 天 → 11-18
    const events: BurndownEvent[] = [];
    for (let i = 0; i < 7; i++) events.push(e("2026-11-0" + (1 + (i % 3)), "done"));
    // 上面 days 不足 7 个，直接精确构造：11-01..11-07 各完成 1 个
    events.length = 0;
    for (let d = 1; d <= 7; d++) events.push(e(`2026-11-0${d}`, "done"));
    const pace = computePace(events, "2026-11-10", 4);
    expect(pace?.ratePerDay).toBeCloseTo(0.5, 6);
    expect(pace?.forecastDay).toBe("2026-11-18");
  });

  it("重开抵扣净速率；窗口外事件不计", () => {
    const events = [
      ...Array.from({ length: 6 }, (_, i) => e(`2026-11-0${i + 1}`, "done") as BurndownEvent),
      e("2026-11-02", "reopened"),
      e("2026-01-01", "done"), // 窗口外
    ];
    // 净 5 个 / 14 天 ≈ 0.357；剩 2 → ceil(5.6)=6 天 → 11-16
    const pace = computePace(events, "2026-11-10", 2);
    expect(pace?.ratePerDay).toBeCloseTo(5 / 14, 6);
    expect(pace?.forecastDay).toBe("2026-11-16");
  });

  it("无净产出或已无剩余：不外推", () => {
    // 完成与重开相抵 → 净速率为 0
    expect(
      computePace([e("2026-11-02", "done"), e("2026-11-03", "reopened")], "2026-11-10", 3),
    ).toEqual({ ratePerDay: 0, forecastDay: null });
    expect(computePace([], "2026-11-10", 0)).toBeNull();
  });
});
