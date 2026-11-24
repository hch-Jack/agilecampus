import { describe, expect, it } from "vitest";
import { railFinalShellWidth } from "@/components/dashboard-paint-freeze";

// 回归：常驻栏开合时「正文可用宽」的符号曾经写反（target - now），
// 导致关闭常驻栏时把工作台先算窄（压缩 + 模糊），清理后又弹回原宽。
const MAX_WIDTH = 1440;
const PADDING = 48;

describe("常驻栏开合后的工作台最终宽度", () => {
  it("1920 宽屏：展开常驻栏只吃居中留白，工作台宽度不变", () => {
    // 收起态正文宽 = 1920 - 30；展开会占掉 274px，但 90rem 封顶后仍是 1440
    expect(
      railFinalShellWidth({
        contentWidth: 1920 - 30,
        paddingX: PADDING,
        railNow: 30,
        targetRailWidth: 304,
        maxWidth: MAX_WIDTH,
      }),
    ).toBe(MAX_WIDTH);
  });

  it("1920 宽屏：关闭常驻栏同样保持 1440，不应先压缩再恢复", () => {
    expect(
      railFinalShellWidth({
        contentWidth: 1920 - 304,
        paddingX: PADDING,
        railNow: 304,
        targetRailWidth: 30,
        maxWidth: MAX_WIDTH,
      }),
    ).toBe(MAX_WIDTH);
  });

  it("1600 宽度：展开确实挤压工作台到可用宽", () => {
    expect(
      railFinalShellWidth({
        contentWidth: 1600 - 30,
        paddingX: PADDING,
        railNow: 30,
        targetRailWidth: 304,
        maxWidth: MAX_WIDTH,
      }),
    ).toBe(1600 - 304 - PADDING);
  });

  it("1600 宽度：关闭恢复封顶宽度", () => {
    expect(
      railFinalShellWidth({
        contentWidth: 1600 - 304,
        paddingX: PADDING,
        railNow: 304,
        targetRailWidth: 30,
        maxWidth: MAX_WIDTH,
      }),
    ).toBe(MAX_WIDTH);
  });

  it("没有 max-width 时完全跟随可用宽", () => {
    expect(
      railFinalShellWidth({
        contentWidth: 1200,
        paddingX: 40,
        railNow: 304,
        targetRailWidth: 30,
        maxWidth: Number.NaN,
      }),
    ).toBe(1200 - 40 + 274);
  });
});
