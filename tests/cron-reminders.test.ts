import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import { createUser, bindFeishu, updateUserTimeZone } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { scanAndNotifyDue } from "@/lib/notify";
import { POST as cronRoute } from "@/app/api/cron/reminders/route";
import { resetDb } from "./helpers";

const sendMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/feishu", () => ({ sendCardMessage: (...a: unknown[]) => sendMock(...a) }));

function req(secret?: string) {
  return new Request("http://test/api/cron/reminders", {
    method: "POST",
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

// 卡片的 JSON：分桶体现在两个小标题上。
// 只认「⏰ 任务提醒」这一种 —— 建任务会 fire-and-forget 地发指派卡片，
// 那些与扫描无关，且可能在 mockClear 之后才落到 mock 上，不能按调用序号去取。
type Card = {
  header?: { title?: { content?: string } };
  elements: { text?: { content: string } }[];
};
const cardText = (card: Card) => card.elements.map((e) => e.text?.content ?? "").join("\n");
const reminders = () =>
  sendMock.mock.calls
    .filter((c) => (c[1] as Card)?.header?.title?.content === "⏰ 任务提醒")
    .map((c) => [c[0] as string, cardText(c[1] as Card)] as const);

describe("scanAndNotifyDue 按负责人各自的时区分桶", () => {
  beforeEach(async () => {
    await resetDb();
    sendMock.mockClear();
  });

  it("同一截止日，上海的人算逾期、UTC 的人算临期", async () => {
    // 钉住时刻：此刻上海是 10-15，UTC 还是 10-14
    const at = new Date("2026-10-14T17:00:00Z");

    const sh = await createUser({ email: "sh@e.com", password: "password123", name: "沪" });
    const utc = await createUser({ email: "utc@e.com", password: "password123", name: "宇" });
    const team = await createTeam(sh.id, "时区");
    await joinTeam(utc.id, team.inviteCode); // 负责人必须先入团
    await createProject(sh.id, team.id, { name: "赤壁" });
    const [project] = await db.select().from(projects).where(eq(projects.teamId, team.id));

    await bindFeishu(sh.id, { openId: "ou_sh", name: "沪" });
    await bindFeishu(utc.id, { openId: "ou_utc", name: "宇" });
    await updateUserTimeZone(sh.id, "Asia/Shanghai");
    await updateUserTimeZone(utc.id, "UTC");

    const dueDate = "2026-10-14";
    await createTask(sh.id, project.id, { title: "上海的活", assigneeId: sh.id, dueDate });
    await createTask(sh.id, project.id, { title: "宇的活", assigneeId: utc.id, dueDate });
    // 建任务时的指派通知与本用例无关，等它落定后清空
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled());
    sendMock.mockClear();

    const { notified, tasksScanned } = await scanAndNotifyDue(at);
    expect(notified).toBe(2);
    expect(tasksScanned).toBe(2);

    const byOpenId = new Map(reminders());
    // 上海已是 10-15，10-14 的活过期了
    expect(byOpenId.get("ou_sh")).toContain("逾期未完成");
    expect(byOpenId.get("ou_sh")).toContain("上海的活");
    // UTC 才 10-14，同一天到期的活只是「即将到期」
    expect(byOpenId.get("ou_utc")).toContain("即将到期");
    expect(byOpenId.get("ou_utc")).not.toContain("逾期未完成");
  });

  it("对某人还太远的任务不进日报 —— SQL 那层的宽松上界要靠 JS 收口", async () => {
    const at = new Date("2026-10-14T17:00:00Z");

    const utc = await createUser({ email: "u@e.com", password: "password123", name: "宇" });
    const team = await createTeam(utc.id, "时区");
    await createProject(utc.id, team.id, { name: "赤壁" });
    const [project] = await db.select().from(projects).where(eq(projects.teamId, team.id));
    await bindFeishu(utc.id, { openId: "ou_u", name: "宇" });
    await updateUserTimeZone(utc.id, "UTC");

    // UTC 的今天是 10-14：10-15 是「明天」→ 该报；10-17 太远 → 不该报。
    // 而 SQL 上界按最东时区（此刻已是 10-15）算到 10-16，
    // 故 10-17 本来就会被 SQL 挡掉 —— 这条盯的是边界内是否被 JS 收干净。
    await createTask(utc.id, project.id, { title: "明天的活", assigneeId: utc.id, dueDate: "2026-10-15" });
    await createTask(utc.id, project.id, { title: "后天的活", assigneeId: utc.id, dueDate: "2026-10-16" });
    await createTask(utc.id, project.id, { title: "下周的活", assigneeId: utc.id, dueDate: "2026-10-17" });
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled());
    sendMock.mockClear();

    const { tasksScanned } = await scanAndNotifyDue(at);
    expect(tasksScanned).toBe(1);
    const text = reminders()[0][1];
    expect(text).toContain("明天的活");
    expect(text).not.toContain("后天的活");
    expect(text).not.toContain("下周的活");
  });
});

describe("POST /api/cron/reminders", () => {
  beforeEach(async () => {
    await resetDb();
    sendMock.mockClear();
    vi.stubEnv("CRON_SECRET", "cron-xyz");
  });

  it("缺 secret → 401", async () => {
    const res = await cronRoute(req());
    expect(res.status).toBe(401);
  });

  it("错 secret → 401", async () => {
    const res = await cronRoute(req("wrong"));
    expect(res.status).toBe(401);
  });

  it("对 secret → 扫描并发提醒", async () => {
    const owner = await createUser({ email: "o@e.com", password: "password123", name: "主帅" });
    const team = await createTeam(owner.id, "东吴");
    const project = await createProject(owner.id, team.id, { name: "赤壁" });
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    await createTask(owner.id, project.id, { title: "临期活", assigneeId: owner.id, dueDate: tomorrow.toISOString().slice(0, 10) });
    // 建任务时会触发一次「新任务指派」通知（fire-and-forget），与本测试要验证的
    // cron 扫描通知无关，等其落定后清空计数，避免污染下面的断言。
    await vi.waitFor(() => expect(sendMock).toHaveBeenCalled());
    sendMock.mockClear();

    const res = await cronRoute(req("cron-xyz"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notified).toBe(1);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
