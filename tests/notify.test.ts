import { describe, it, expect, beforeEach, vi } from "vitest";
import { createUser, bindFeishu } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, listProjectTasks } from "@/lib/task";
import { commitDraft } from "@/lib/agent/commit";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb } from "./helpers";

// mock 飞书斥候：只验是否被调、收件人与卡片内容
const sendMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/feishu", () => ({ sendCardMessage: (...a: unknown[]) => sendMock(...a) }));

async function base() {
  const owner = await createUser({ email: "owner@e.com", password: "password123", name: "主帅" });
  const team = await createTeam(owner.id, "东吴");
  const project = await createProject(owner.id, team.id, { name: "赤壁" });
  return { owner, team, project };
}

describe("notifyTaskAssigned", () => {
  beforeEach(async () => { await resetDb(); sendMock.mockClear(); });

  it("负责人已绑飞书 → 发私信", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const task = await createTask(owner.id, project.id, { title: "斥候", assigneeId: owner.id, dueDate: "2026-08-01" });

    await new Promise((r) => setTimeout(r, 50)); // 让 createTask 的游离即时通知先跑完
    sendMock.mockClear();                         // 清掉 createTask 副作用产生的调用

    const { notifyTaskAssigned } = await import("@/lib/notify");
    await notifyTaskAssigned(task);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("ou_owner");
    expect(JSON.stringify(sendMock.mock.calls[0][1])).toContain("斥候"); // 卡片含任务标题
  });

  it("负责人未绑飞书 → 跳过", async () => {
    const { owner, project } = await base();
    const task = await createTask(owner.id, project.id, { title: "x", assigneeId: owner.id });
    const { notifyTaskAssigned } = await import("@/lib/notify");
    await notifyTaskAssigned(task);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("无负责人 → 跳过", async () => {
    const { owner, project } = await base();
    const task = await createTask(owner.id, project.id, { title: "x" });
    const { notifyTaskAssigned } = await import("@/lib/notify");
    await notifyTaskAssigned(task);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("飞书发送抛错 → 不抛出（fire-and-forget）", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const task = await createTask(owner.id, project.id, { title: "x", assigneeId: owner.id });
    sendMock.mockRejectedValueOnce(new Error("飞书挂了"));
    const { notifyTaskAssigned } = await import("@/lib/notify");
    await expect(notifyTaskAssigned(task)).resolves.toBeUndefined();
  });
});

describe("notifyTaskCompleted", () => {
  beforeEach(async () => { await resetDb(); sendMock.mockClear(); });

  it("创建者≠操作者且已绑 → 通知创建者", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const doer = await createUser({ email: "doer@e.com", password: "password123", name: "小卒" });
    const task = await createTask(owner.id, project.id, { title: "攻城" });

    const { notifyTaskCompleted } = await import("@/lib/notify");
    await notifyTaskCompleted(task, doer.id);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("ou_owner");
  });

  it("创建者=操作者、自己也是负责人 → 给自己发完成回执", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const task = await createTask(owner.id, project.id, { title: "攻城", assigneeId: owner.id });
    await new Promise((r) => setTimeout(r, 50)); // 先让 createTask 的指派通知跑完
    sendMock.mockClear();

    const { notifyTaskCompleted } = await import("@/lib/notify");
    await notifyTaskCompleted(task, owner.id);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("ou_owner");
  });

  it("创建者=操作者、负责人是别人 → 通知负责人", async () => {
    const { owner, team, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const doer = await createUser({ email: "doer@e.com", password: "password123", name: "小卒" });
    await joinTeam(doer.id, team.inviteCode);
    await bindFeishu(doer.id, { openId: "ou_doer", name: "小卒" });
    const task = await createTask(owner.id, project.id, { title: "攻城", assigneeId: doer.id });
    await new Promise((r) => setTimeout(r, 50));
    sendMock.mockClear();

    const { notifyTaskCompleted } = await import("@/lib/notify");
    await notifyTaskCompleted(task, owner.id);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("ou_doer");
  });

  it("创建者=操作者且无负责人 → 无人可发，跳过", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const task = await createTask(owner.id, project.id, { title: "攻城" });
    const { notifyTaskCompleted } = await import("@/lib/notify");
    await notifyTaskCompleted(task, owner.id);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("助手批量改派（commitDraft update_tasks）的通知", () => {
  beforeEach(async () => { await resetDb(); sendMock.mockClear(); });

  it("新负责人各收到一张指派卡片；已是该负责人的不重发", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    await createTask(owner.id, project.id, { title: "甲" });
    await createTask(owner.id, project.id, { title: "乙", assigneeId: owner.id });
    await new Promise((r) => setTimeout(r, 50)); // 清掉 createTask 的指派通知
    sendMock.mockClear();

    const rows = await listProjectTasks(owner.id, project.id);
    const r = await commitDraft(owner.id, project.id, "update_tasks", {
      updates: rows.map((row) => ({
        taskId: row.id,
        updatedAt: row.updatedAt.toISOString(),
        patch: { assigneeId: owner.id },
      })),
    });
    expect(r.committed).toBe(2);
    await new Promise((r) => setTimeout(r, 100)); // 等事务提交后的游离通知

    // 只有「甲」是真正改派；「乙」本来就是 Yu，不该再收到一张
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toBe("ou_owner");
    expect(JSON.stringify(sendMock.mock.calls[0][1])).toContain("甲");
  });
});

describe("scanAndNotifyDue", () => {
  beforeEach(async () => { await resetDb(); sendMock.mockClear(); });

  it("临期(明日)+逾期(昨日)按负责人聚合为一封", async () => {
    const { owner, project } = await base();
    await bindFeishu(owner.id, { openId: "ou_owner", name: "主帅" });
    const today = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
    const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);

    await createTask(owner.id, project.id, { title: "临期活", assigneeId: owner.id, dueDate: iso(tomorrow) });
    await createTask(owner.id, project.id, { title: "逾期活", assigneeId: owner.id, dueDate: iso(yesterday) });
    // done 的逾期任务不计
    const doneTask = await createTask(owner.id, project.id, { title: "已完成", assigneeId: owner.id, dueDate: iso(yesterday) });
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, doneTask.id));

    await new Promise((r) => setTimeout(r, 50)); // 让 createTask 的游离即时通知先跑完
    sendMock.mockClear();                         // 清掉 createTask 副作用产生的调用

    const { scanAndNotifyDue } = await import("@/lib/notify");
    const r = await scanAndNotifyDue();

    expect(sendMock).toHaveBeenCalledTimes(1); // 同一负责人一封
    const card = JSON.stringify(sendMock.mock.calls[0][1]);
    expect(card).toContain("临期活");
    expect(card).toContain("逾期活");
    expect(card).not.toContain("已完成");
    expect(r.notified).toBe(1);
  });

  it("未绑飞书的负责人 → 不发", async () => {
    const { owner, project } = await base();
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    await createTask(owner.id, project.id, { title: "x", assigneeId: owner.id, dueDate: tomorrow.toISOString().slice(0, 10) });
    const { scanAndNotifyDue } = await import("@/lib/notify");
    const r = await scanAndNotifyDue();
    expect(sendMock).not.toHaveBeenCalled();
    expect(r.notified).toBe(0);
  });
});
