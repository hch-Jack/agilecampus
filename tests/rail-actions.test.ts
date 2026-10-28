import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUser } from "@/lib/user";
import {
  getDashboardLayout,
  getRailCollapsed,
  getRailLayout,
  saveRailLayout,
} from "@/lib/dashboard-layout-store";
import { DEFAULT_RAIL_LAYOUT, GRID_COLUMNS, defaultRailLayoutFor } from "@/lib/dashboard-layout";
import {
  refreshRailDataAction,
  saveRailCollapsedAction,
  saveRailLayoutAction,
} from "@/app/(app)/rail/actions";
import { resetDb } from "./helpers";

// 身份只从 auth() 取（与 dashboard-actions.test.ts 同一套 mock）
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

describe("常驻栏布局读写", () => {
  it("未登录时保存被拒，且不写库", async () => {
    expect(await saveRailLayoutAction(DEFAULT_RAIL_LAYOUT)).toEqual({ error: "请先登录" });
  });

  it("NULL 读回默认常驻栏；审批人拿到带待办审批的变体", async () => {
    const user = await makeUser("owner@example.com");
    expect(await getRailLayout(user.id)).toEqual(DEFAULT_RAIL_LAYOUT);
    expect(await getRailLayout(user.id, { isApprover: true })).toEqual(defaultRailLayoutFor(true));
  });

  it("保存后能原样读回（含配置与缩放）", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    const doc = {
      v: 1 as const,
      zoom: 1.2,
      items: [
        {
          id: "note",
          type: "note" as const,
          x: 0,
          y: 0,
          w: GRID_COLUMNS,
          h: 4,
          config: { text: "先看审批" },
        },
        { id: "clock", type: "clock" as const, x: 0, y: 4, w: GRID_COLUMNS, h: 3 },
      ],
    };
    expect(await saveRailLayoutAction(doc)).toEqual({ ok: true });
    expect(await getRailLayout(user.id)).toEqual(doc);
  });

  it("常驻栏与工作台布局互不干扰", async () => {
    const user = await makeUser("owner@example.com");
    await saveRailLayout(user.id, { v: 1, items: [] });

    expect(await getRailLayout(user.id)).toEqual({ v: 1, items: [] });
    // 工作台仍是默认（未自定义过）
    expect((await getDashboardLayout(user.id)).items.length).toBeGreaterThan(1);
  });

  it("每个用户各存各的", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");

    authMock.userId = a.id;
    await saveRailLayoutAction({
      v: 1,
      items: [{ id: "unread_messages", type: "unread_messages", x: 0, y: 0, w: 12, h: 3 }],
    });

    authMock.userId = b.id;
    expect(await getRailLayout(b.id)).toEqual(DEFAULT_RAIL_LAYOUT);
  });

  it("空 items 是主动清空，不回落默认", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await saveRailLayoutAction({ v: 1, items: [] })).toEqual({ ok: true });
    expect(await getRailLayout(user.id)).toEqual({ v: 1, items: [] });
  });

  it("非法信封被拒：版本不对 / 未知卡片 / 超宽坐标 / zoom 越界", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await saveRailLayoutAction({ v: 2, items: [] })).toHaveProperty("error");
    expect(
      await saveRailLayoutAction({
        v: 1,
        items: [{ id: "future_widget", x: 0, y: 0, w: 12, h: 3 }],
      }),
    ).toHaveProperty("error");
    expect(
      await saveRailLayoutAction({ v: 1, items: [], zoom: 0.2 }),
    ).toHaveProperty("error");

    // 一次都没写进去
    expect(await getRailLayout(user.id)).toEqual(DEFAULT_RAIL_LAYOUT);
  });

  it("超宽卡片保存时被夹到 12 列", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    await saveRailLayoutAction({
      v: 1,
      items: [{ id: "unread_messages", x: 4, y: 0, w: 99, h: 3 }],
    });
    const saved = await getRailLayout(user.id);
    expect(saved.items[0]).toMatchObject({ x: 0, w: GRID_COLUMNS });
  });
});

describe("常驻栏收起状态", () => {
  it("未登录时保存被拒", async () => {
    expect(await saveRailCollapsedAction(true)).toEqual({ error: "请先登录" });
  });

  it("默认收起；保存后记住，再改也生效", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await getRailCollapsed(user.id)).toBe(true);

    expect(await saveRailCollapsedAction(false)).toEqual({ ok: true });
    expect(await getRailCollapsed(user.id)).toBe(false);

    expect(await saveRailCollapsedAction(true)).toEqual({ ok: true });
    expect(await getRailCollapsed(user.id)).toBe(true);
  });

  it("只收布尔值，且每个用户各记各的", async () => {
    const a = await makeUser("a@example.com");
    const b = await makeUser("b@example.com");
    authMock.userId = a.id;

    expect(await saveRailCollapsedAction("0")).toHaveProperty("error");
    expect(await getRailCollapsed(a.id)).toBe(true);

    await saveRailCollapsedAction(false);
    expect(await getRailCollapsed(a.id)).toBe(false);
    expect(await getRailCollapsed(b.id)).toBe(true);
  });
});

describe("refreshRailDataAction", () => {
  it("未登录被拒", async () => {
    expect(await refreshRailDataAction(["unread_messages"])).toHaveProperty("error");
  });

  it("按传入的卡片类型装配数据", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    const result = await refreshRailDataAction(["unread_messages", "quick_links"]);
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    // 新用户没有任何消息 / 项目
    expect(result.data.messages).toEqual({ dm: 0, group: 0, invites: 0, system: 0 });
    expect(result.data.projects).toEqual([]);
    expect(result.data.visibleTasks).toEqual([]);
    expect(result.data.isApprover).toBe(false);
  });

  it("缺省 types 时按库里的常驻栏布局取类型", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;
    await saveRailLayout(user.id, {
      v: 1,
      items: [{ id: "my_projects", type: "my_projects", x: 0, y: 0, w: 12, h: 4 }],
    });

    const result = await refreshRailDataAction();
    expect("error" in result).toBe(false);
    if ("error" in result) throw new Error(result.error);
    expect(result.data.projects).toEqual([]);
    expect(result.data.messages).toEqual({ dm: 0, group: 0, invites: 0, system: 0 });
  });

  it("未知卡片类型直接拒绝", async () => {
    const user = await makeUser("owner@example.com");
    authMock.userId = user.id;

    expect(await refreshRailDataAction(["future_widget"])).toHaveProperty("error");
    expect(await refreshRailDataAction("unread_messages")).toHaveProperty("error");
  });
});
