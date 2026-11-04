import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createUser } from "@/lib/user";
import { getDashboardLayout } from "@/lib/dashboard-layout-store";
import {
  DASHBOARD_WIDGETS,
  DEFAULT_DASHBOARD_LAYOUT,
  NOTE_MAX_LENGTH,
} from "@/lib/dashboard-layout";
import { saveDashboardLayoutAction } from "@/app/(app)/dashboard/actions";
import { resetDb } from "./helpers";

// 身份只从 auth() 取；不碰 next/cache（保存刻意不 revalidate）
const authMock = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

beforeEach(async () => {
  await resetDb();
  authMock.userId = null;
});

describe("saveDashboardLayoutAction", () => {
  it("未登录直接拒绝，不写库", async () => {
    const result = await saveDashboardLayoutAction(DEFAULT_DASHBOARD_LAYOUT);
    expect(result).toEqual({ error: "请先登录" });
  });

  it("保存后能原样读回；NULL 读回默认布局", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await getDashboardLayout(user.id)).toEqual(DEFAULT_DASHBOARD_LAYOUT);

    const doc = {
      v: 1 as const,
      items: [
        {
          id: "note",
          type: "note" as const,
          x: 0,
          y: 0,
          w: 4,
          h: 4,
          config: { text: "先做答辩 PPT" },
        },
        { id: "clock", type: "clock" as const, x: 4, y: 0, w: 4, h: 3 },
      ],
    };
    expect(await saveDashboardLayoutAction(doc)).toEqual({ ok: true });
    expect(await getDashboardLayout(user.id)).toEqual(doc);
  });

  it("空 items 是主动删空，不会回落默认", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await saveDashboardLayoutAction({ v: 1, items: [] })).toEqual({ ok: true });
    expect(await getDashboardLayout(user.id)).toEqual({ v: 1, items: [] });
  });

  it("每个用户各存各的", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");

    authMock.userId = a.id;
    await saveDashboardLayoutAction({
      v: 1,
      items: [{ id: "note", x: 0, y: 0, w: 4, h: 4, config: { text: "A 的便签" } }],
    });

    authMock.userId = b.id;
    expect(await getDashboardLayout(b.id)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
    await saveDashboardLayoutAction({
      v: 1,
      items: [{ id: "clock", x: 0, y: 0, w: 3, h: 2 }],
    });

    authMock.userId = a.id;
    const aLayout = await getDashboardLayout(a.id);
    expect(aLayout.items[0]).toMatchObject({
      id: "note",
      type: "note",
      config: { text: "A 的便签" },
    });
  });

  it("越界坐标被夹回网格，超长便签被截断", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    const result = await saveDashboardLayoutAction({
      v: 1,
      items: [
        { id: "task_board", x: 99, y: -5, w: 99, h: 0, config: { text: "字".repeat(700) } },
      ],
    });
    expect(result).toEqual({ ok: true });

    const saved = await getDashboardLayout(user.id);
    const board = saved.items[0];
    expect(board).toMatchObject({
      id: "task_board",
      w: 12,
      h: DASHBOARD_WIDGETS.task_board.minSize.h,
    });
    expect(board.x).toBe(0);
    expect(board.config).toBeUndefined(); // task_board 不支持便签配置
  });

  it("可重复卡多实例都保存；单例卡同类型只留第一张", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    await saveDashboardLayoutAction({
      v: 1,
      items: [
        { id: "note", type: "note", x: 0, y: 0, w: 4, h: 4 },
        { id: "note-2", type: "note", x: 4, y: 0, w: 4, h: 4 },
        { id: "clock", type: "clock", x: 0, y: 4, w: 4, h: 3 },
        { id: "clock-2", type: "clock", x: 4, y: 4, w: 4, h: 3 },
        { id: "quick_links", type: "quick_links", x: 8, y: 0, w: 3, h: 3 },
        { id: "quick_links-2", type: "quick_links", x: 8, y: 3, w: 3, h: 3 },
      ],
    });
    expect((await getDashboardLayout(user.id)).items.map((item) => item.id)).toEqual([
      "note",
      "note-2",
      "quick_links",
      "clock",
      "clock-2",
    ]);
  });

  it("时钟的农历与世界时钟配置能原样读回", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    await saveDashboardLayoutAction({
      v: 1,
      items: [
        {
          id: "clock",
          type: "clock",
          x: 0,
          y: 0,
          w: 4,
          h: 3,
          config: { lunar: true, zones: ["Asia/Tokyo", "Europe/London"] },
        },
      ],
    });
    expect((await getDashboardLayout(user.id)).items[0].config).toEqual({
      lunar: true,
      zones: ["Asia/Tokyo", "Europe/London"],
    });
  });

  it("便签超过上限被截到 NOTE_MAX_LENGTH", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    await saveDashboardLayoutAction({
      v: 1,
      items: [{ id: "note", x: 0, y: 0, w: 4, h: 4, config: { text: "字".repeat(600) } }],
    });
    expect((await getDashboardLayout(user.id)).items[0].config?.text).toHaveLength(NOTE_MAX_LENGTH);
  });

  it("缩放随布局往返；缺省与非法值都不落库", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    const doc = { ...DEFAULT_DASHBOARD_LAYOUT, zoom: 1.3 };
    expect(await saveDashboardLayoutAction(doc)).toEqual({ ok: true });
    expect((await getDashboardLayout(user.id)).zoom).toBe(1.3);

    // 1 等价于标准，不写字段
    expect(await saveDashboardLayoutAction({ ...DEFAULT_DASHBOARD_LAYOUT, zoom: 1 })).toEqual({
      ok: true,
    });
    expect(await getDashboardLayout(user.id)).not.toHaveProperty("zoom");
  });

  it("zoom 超出合法范围或被夹到边界后能被读出", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    // 信封层直接拒绝明显非法的缩放
    expect(await saveDashboardLayoutAction({ v: 1, items: [], zoom: 0.2 })).toHaveProperty("error");
    expect(await saveDashboardLayoutAction({ v: 1, items: [], zoom: "1.2" })).toHaveProperty("error");
    expect(await getDashboardLayout(user.id)).toEqual(DEFAULT_DASHBOARD_LAYOUT);

    // 库里已有的越界值（旧数据 / 手改）读出来时夹到边界
    await db
      .update(users)
      .set({ dashboardLayout: { v: 1, items: [], zoom: 5 } })
      .where(eq(users.id, user.id));
    expect((await getDashboardLayout(user.id)).zoom).toBe(1.5);
  });

  it("信封不合法时拒绝：版本不对 / 未知卡片 / 负数或非整数 / 数组超限 / 便签过长", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await saveDashboardLayoutAction({ v: 2, items: [] })).toHaveProperty("error");
    expect(
      await saveDashboardLayoutAction({ v: 1, items: [{ id: "future_widget", x: 0, y: 0, w: 1, h: 1 }] }),
    ).toHaveProperty("error");
    expect(
      await saveDashboardLayoutAction({ v: 1, items: [{ id: "clock", x: 0.5, y: 0, w: 3, h: 2 }] }),
    ).toHaveProperty("error");
    expect(await saveDashboardLayoutAction({ v: 1, items: new Array(41).fill({ id: "clock", x: 0, y: 0, w: 4, h: 3 }) })).toHaveProperty(
      "error",
    );
    expect(
      await saveDashboardLayoutAction({
        v: 1,
        items: [{ id: "note", x: 0, y: 0, w: 4, h: 4, config: { text: "字".repeat(3000) } }],
      }),
    ).toHaveProperty("error");

    // 一次都没有写进去
    expect(await getDashboardLayout(user.id)).toEqual(DEFAULT_DASHBOARD_LAYOUT);
  });
});
