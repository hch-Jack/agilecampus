import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { listMyTaskPlans } from "@/lib/task-plan";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { buildPersonalTools, taskPlanDraftSchema } from "@/lib/agent/tools";
import { widgetOpsDraftSchema } from "@/lib/agent/widget-ops";
import {
  defaultDashboardLayoutFor,
  normalizeLayoutDoc,
} from "@/lib/dashboard-layout";
import {
  getDashboardLayout,
  getRailLayout,
  saveDashboardLayout,
} from "@/lib/dashboard-layout-store";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, team, student, outsider, project };
}

// AI SDK 的 tool.execute 签名为 (input, options)；测试直调传占位 options
const opts = {} as never;

type WidgetDraft = {
  surface: "dashboard" | "rail";
  ops: unknown[];
  summary: string[];
};

describe("list_dashboard_widgets", () => {
  beforeEach(resetDb);

  it("给出两块网格的现状：instanceId、配置、常驻栏收起状态", async () => {
    const { student } = await scene();
    const view = (await buildPersonalTools(student.id).list_dashboard_widgets.execute!(
      {},
      opts,
    )) as {
      dashboard: { surface: string; zoom: number; items: Record<string, unknown>[] };
      rail: { surface: string; collapsed: boolean; items: Record<string, unknown>[] };
    };

    expect(view.dashboard.surface).toBe("dashboard");
    expect(view.dashboard.zoom).toBe(1);
    // 默认布局原样可见，便签/时钟/倒计时都在 —— 模型据此判断「还用不用再加一张」
    expect(view.dashboard.items.find((i) => i.instanceId === "note")).toMatchObject({
      type: "note",
      title: "便签",
    });
    expect(view.dashboard.items.find((i) => i.instanceId === "clock")).toMatchObject({
      type: "clock",
      title: "时钟",
    });

    expect(view.rail.surface).toBe("rail");
    expect(view.rail.items.map((i) => i.instanceId)).toEqual([
      "unread_messages",
      "upcoming",
      "quick_links",
      "clock",
    ]);
    // 从未设置过 → 默认收起
    expect(view.rail.collapsed).toBe(true);
  });

  it("隔离：只看到自己的布局", async () => {
    const { student, outsider } = await scene();
    await saveDashboardLayout(student.id, {
      v: 1,
      items: [{ id: "note", type: "note", x: 0, y: 0, w: 4, h: 4, config: { text: "我的私事" } }],
    });

    const view = (await buildPersonalTools(outsider.id).list_dashboard_widgets.execute!(
      {},
      opts,
    )) as { dashboard: { items: { instanceId: string; config?: { text?: string } }[] } };
    expect(JSON.stringify(view.dashboard.items)).not.toContain("我的私事");
  });
});

describe("manage_dashboard_widgets：草案不落库，确认才写", () => {
  beforeEach(resetDb);

  it("加一张带正文的便签：草案带摘要，确认后写进布局并回传保存的 doc", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.manage_dashboard_widgets.execute!(
      {
        surface: "dashboard",
        ops: [{ action: "add", type: "note", w: 6, h: 3, config: { text: "周三带实验报告" } }],
      },
      opts,
    )) as { __draft: true; tool: string; draft: WidgetDraft };

    expect(env).toMatchObject({ __draft: true, tool: "manage_dashboard_widgets" });
    expect(env.draft.surface).toBe("dashboard");
    expect(env.draft.summary).toEqual(["新增便签「周三带实验报告」（6×3 格）"]);

    // 拟稿阶段一个字都不写库
    const before = await getDashboardLayout(student.id);
    expect(before.items.find((i) => i.id === "note-2")).toBeUndefined();

    const res = await commitPersonalDraft(student.id, "manage_dashboard_widgets", env.draft);
    expect(res.committed).toBe(1);
    expect(res.layout?.surface).toBe("dashboard");

    const saved = await getDashboardLayout(student.id);
    expect(saved.items.find((i) => i.id === "note-2")).toMatchObject({
      type: "note",
      x: 0,
      w: 6,
      h: 3,
      config: { text: "周三带实验报告" },
    });
    // 回传的 doc 与库里的完全一致，客户端直接拿它更新网格
    expect(res.layout?.doc).toEqual(saved);
  });

  it("删除 / 改配置 / 移动 / 缩放 / 调网格缩放按顺序执行", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.manage_dashboard_widgets.execute!(
      {
        surface: "dashboard",
        ops: [
          { action: "update_config", instanceId: "note", config: { text: "先记一笔" } },
          { action: "move", instanceId: "note", x: 4, y: 0 },
          { action: "resize", instanceId: "note", w: 6, h: 4 },
          { action: "set_zoom", zoom: 0.9 },
          { action: "remove", instanceId: "focus_timer" },
        ],
      },
      opts,
    )) as { draft: WidgetDraft };

    expect(env.draft.summary).toEqual([
      "便签内容改为「先记一笔」",
      "移动便签「先记一笔」到第 5 列、第 1 行",
      "把便签「先记一笔」改成 6×4 格",
      "网格缩放改为 90%",
      "删除专注计时（3×3 格）",
    ]);

    await commitPersonalDraft(student.id, "manage_dashboard_widgets", env.draft);
    const saved = await getDashboardLayout(student.id);
    expect(saved.items.find((i) => i.id === "note")).toMatchObject({
      x: 4,
      y: 0,
      w: 6,
      h: 4,
      config: { text: "先记一笔" },
    });
    expect(saved.items.some((i) => i.type === "focus_timer")).toBe(false);
    expect(saved.zoom).toBe(0.9);
  });

  it("reset 恢复与页面一致的默认布局（审批人多一张待办审批）", async () => {
    const { owner } = await scene();
    const tools = buildPersonalTools(owner.id);

    const env = (await tools.manage_dashboard_widgets.execute!(
      { surface: "dashboard", ops: [{ action: "reset" }] },
      opts,
    )) as { draft: WidgetDraft };
    expect(env.draft.summary).toEqual(["恢复默认布局（自定义卡片与各卡片设置都会清空）"]);

    await commitPersonalDraft(owner.id, "manage_dashboard_widgets", env.draft);
    const saved = await getDashboardLayout(owner.id, { isApprover: true });
    expect(saved).toEqual(normalizeLayoutDoc(defaultDashboardLayoutFor(true)));
    expect(saved.items.some((i) => i.type === "approvals")).toBe(true);
  });

  it("rail：新卡默认满宽，且不会碰到工作台的布局", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.manage_dashboard_widgets.execute!(
      {
        surface: "rail",
        ops: [{ action: "add", type: "note", config: { text: "栏内便签" } }],
      },
      opts,
    )) as { draft: WidgetDraft };
    expect(env.draft.summary).toEqual(["新增便签「栏内便签」（12×4 格）"]);

    await commitPersonalDraft(student.id, "manage_dashboard_widgets", env.draft);
    expect((await getRailLayout(student.id)).items.find((i) => i.id === "note")).toMatchObject({
      type: "note",
      w: 12,
      h: 4,
      config: { text: "栏内便签" },
    });
    // 同名的 note 在工作台里仍是默认那张（无正文）
    expect(
      (await getDashboardLayout(student.id)).items.find((i) => i.id === "note")?.config,
    ).toBeUndefined();
  });

  it("落库时重读最新布局：拟稿后用户又改过，不会覆盖用户的改动", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.manage_dashboard_widgets.execute!(
      {
        surface: "dashboard",
        ops: [{ action: "update_config", instanceId: "note", config: { text: "助手写的" } }],
      },
      opts,
    )) as { draft: WidgetDraft };

    // 拟稿与确认之间，用户在界面上又加了一张卡
    const before = await getDashboardLayout(student.id);
    await saveDashboardLayout(student.id, {
      v: 1,
      items: [
        ...before.items,
        { id: "note-9", type: "note", x: 0, y: 40, w: 3, h: 3, config: { text: "手加的" } },
      ],
    });

    await commitPersonalDraft(student.id, "manage_dashboard_widgets", env.draft);
    const after = await getDashboardLayout(student.id);
    expect(after.items.find((i) => i.id === "note-9")?.config?.text).toBe("手加的");
    expect(after.items.find((i) => i.id === "note")?.config?.text).toBe("助手写的");
  });

  it("id 不存在 / 单例卡重复 / 不可配置的卡片都在拟稿时讲清楚", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);
    const run = (ops: unknown[]) =>
      tools.manage_dashboard_widgets.execute!(
        { surface: "dashboard", ops } as never,
        opts,
      );

    // 不知道 id 就去调 list_dashboard_widgets，而不是猜一个
    await expect(run([{ action: "remove", instanceId: "nope" }])).rejects.toThrow(
      "list_dashboard_widgets",
    );
    // 单例卡（我的项目已在默认布局里）
    await expect(run([{ action: "add", type: "my_projects" }])).rejects.toThrow("只能有一张");
    // 内容来自数据的卡片没有设置可改
    await expect(
      run([{ action: "update_config", instanceId: "task_board", config: { text: "x" } }]),
    ).rejects.toThrow("没有可调整的设置");
  });

  it("落库口不信草案：坏形状照样被挡下", async () => {
    const { student } = await scene();
    await expect(
      commitPersonalDraft(student.id, "manage_dashboard_widgets", {
        surface: "dashboard",
        ops: [{ action: "remove", instanceId: "nope" }],
      }),
    ).rejects.toThrow("list_dashboard_widgets");
    await expect(
      commitPersonalDraft(student.id, "manage_dashboard_widgets", {
        surface: "elsewhere",
        ops: [],
      }),
    ).rejects.toThrow();
  });

  it("ops 形状由 zod 把关：空 ops、未知 action、越界坐标、空配置都不收", () => {
    expect(() => widgetOpsDraftSchema.parse({ surface: "dashboard", ops: [] })).toThrow();
    expect(() =>
      widgetOpsDraftSchema.parse({ surface: "dashboard", ops: [{ action: "explode" }] }),
    ).toThrow();
    expect(() =>
      widgetOpsDraftSchema.parse({
        surface: "dashboard",
        ops: [{ action: "move", instanceId: "note", x: 12, y: 0 }],
      }),
    ).toThrow();
    expect(() =>
      widgetOpsDraftSchema.parse({
        surface: "dashboard",
        ops: [{ action: "update_config", instanceId: "note", config: {} }],
      }),
    ).toThrow();
    expect(() =>
      widgetOpsDraftSchema.parse({
        surface: "dashboard",
        ops: [{ action: "set_zoom", zoom: 3 }],
      }),
    ).toThrow();
  });
});

describe("manage_task_plans：日程表里的「我打算哪天做」", () => {
  beforeEach(resetDb);

  it("排期 / 删除一段 / 清空：草案带任务标题，确认后才写我的计划日", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, {
      title: "写开题报告",
      assigneeId: student.id,
    });
    const tools = buildPersonalTools(student.id);

    const env = (await tools.manage_task_plans.execute!(
      {
        ops: [
          { action: "add", taskId: task.id, start: "2026-11-02" },
          { action: "add", taskId: task.id, start: "2026-11-04", end: "2026-11-06" },
        ],
      },
      opts,
    )) as { __draft: true; tool: string; draft: { ops: unknown[]; summary: string[] } };

    expect(env).toMatchObject({ __draft: true, tool: "manage_task_plans" });
    expect(env.draft.summary).toEqual([
      "「写开题报告」排到 2026-11-02",
      "「写开题报告」排到 2026-11-04 → 2026-11-06",
    ]);
    expect(await listMyTaskPlans(student.id, [task.id])).toEqual({});

    await commitPersonalDraft(student.id, "manage_task_plans", env.draft);
    expect(await listMyTaskPlans(student.id, [task.id])).toEqual({
      [task.id]: [
        { start: "2026-11-02", end: "2026-11-02" },
        { start: "2026-11-04", end: "2026-11-06" },
      ],
    });

    const env2 = (await tools.manage_task_plans.execute!(
      {
        ops: [
          { action: "remove", taskId: task.id, start: "2026-11-04", end: "2026-11-06" },
          { action: "clear", taskId: task.id },
        ],
      },
      opts,
    )) as { draft: { ops: unknown[]; summary: string[] } };
    expect(env2.draft.summary).toEqual([
      "删掉「写开题报告」的计划 2026-11-04 → 2026-11-06",
      "清空「写开题报告」的全部计划日",
    ]);
    await commitPersonalDraft(student.id, "manage_task_plans", env2.draft);
    expect(await listMyTaskPlans(student.id, [task.id])).toEqual({});
  });

  it("只动计划日，不碰任务官方起止日", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, {
      title: "写开题报告",
      assigneeId: student.id,
      startDate: "2026-11-01",
      dueDate: "2026-11-10",
    });
    const tools = buildPersonalTools(student.id);

    const env = (await tools.manage_task_plans.execute!(
      { ops: [{ action: "add", taskId: task.id, start: "2026-11-03" }] },
      opts,
    )) as { draft: unknown };
    await commitPersonalDraft(student.id, "manage_task_plans", env.draft);

    const [row] = await db
      .select({ startDate: tasks.startDate, dueDate: tasks.dueDate })
      .from(tasks)
      .where(eq(tasks.id, task.id));
    expect(row).toEqual({ startDate: "2026-11-01", dueDate: "2026-11-10" });
  });

  it("老师只读：拟稿照给，确认时被拒；外人连拟稿都拿不到", async () => {
    const { owner, team, project, outsider } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const teacher = await makeUser("teacher@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");

    const teacherTools = buildPersonalTools(teacher.id);
    const env = (await teacherTools.manage_task_plans.execute!(
      { ops: [{ action: "add", taskId: task.id, start: "2026-11-02" }] },
      opts,
    )) as { draft: unknown };
    await expect(
      commitPersonalDraft(teacher.id, "manage_task_plans", env.draft),
    ).rejects.toThrow();
    expect(await listMyTaskPlans(teacher.id, [task.id])).toEqual({});

    await expect(
      buildPersonalTools(outsider.id).manage_task_plans.execute!(
        { ops: [{ action: "add", taskId: task.id, start: "2026-11-02" }] },
        opts,
      ),
    ).rejects.toThrow("没有权限");
  });

  it("日期形状由 zod 把关：格式不对、日子不存在都拦在拟稿前", () => {
    expect(() =>
      taskPlanDraftSchema.parse({
        ops: [{ action: "add", taskId: "00000000-0000-4000-8000-000000000000", start: "11/02" }],
      }),
    ).toThrow();
    expect(() =>
      taskPlanDraftSchema.parse({
        ops: [{ action: "add", taskId: "00000000-0000-4000-8000-000000000000", start: "2026-02-30" }],
      }),
    ).toThrow();
  });
});
