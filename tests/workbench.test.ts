import { describe, it, expect, beforeEach, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject, updateProject } from "@/lib/project";
import { createTask, createSubtask, listMySubtaskProgress, listMyTasks, updateTask } from "@/lib/task";
import {
  clearFeed,
  deleteActivityForUser,
  getFeedUnreadCount,
  listMyTaskActivities,
  listProjectActivities,
  listTaskActivities,
  markFeedRead,
  projectFeedScope,
  taskFeedScope,
  WORKBENCH_SCOPE,
} from "@/lib/activity";
import { ForbiddenError } from "@/lib/errors";
import {
  dashboardHref,
  pickProjectFilter,
  projectChips,
} from "@/lib/workbench-filters";
import { db } from "@/db";
import { feedReads, taskActivities, tasks as tasksTable } from "@/db/schema";
import { moveTaskAction } from "@/app/(app)/projects/[projectId]/actions";
import { clearFeedAction, deleteActivityAction, markFeedReadAction } from "@/app/(app)/actions";
import { resetDb } from "./helpers";

// moveTaskAction 走 auth() 与 revalidatePath，须 mock（照 task-detail-features.test.ts 头部惯例）
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
// 默认空实现须接受可变参数（tsc 展开要求），void a 防 lint 未用告警
const revalidateMock = vi.hoisted(() => ({ fn: (...a: unknown[]) => { void a; } }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidateMock.fn(...a) }));
// updateTask 置 done 会 fire-and-forget 飞书通知，mock 掉免外呼
vi.mock("@/lib/feishu", () => ({ sendCardMessage: async () => {} }));

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function taskStatus(taskId: string) {
  const [row] = await db
    .select({ status: tasksTable.status })
    .from(tasksTable)
    .where(eq(tasksTable.id, taskId));
  return row?.status;
}

async function scene() {
  const owner = await makeUser("owner@example.com"); // admin
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const teacher = await makeUser("teacher@example.com");
  await joinTeam(teacher.id, team.inviteCode);
  await updateMemberRole(owner.id, team.id, teacher.id, "teacher");
  const outsider = await makeUser("outsider@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, team, student, teacher, outsider, project };
}

beforeEach(async () => {
  await resetDb();
  authMock.userId = null;
  revalidateMock.fn = () => {};
});

describe("listMyTasks", () => {
  it("跨团队聚合并带出项目名与角色", async () => {
    const owner = await makeUser("owner@example.com");
    const t1 = await createTeam(owner.id, "甲组");
    const t2 = await createTeam(owner.id, "乙组");
    const student = await makeUser("student@example.com");
    await joinTeam(student.id, t1.inviteCode);
    await joinTeam(student.id, t2.inviteCode);
    const p1 = await createProject(owner.id, t1.id, { name: "项目一" });
    const p2 = await createProject(owner.id, t2.id, { name: "项目二" });
    await createTask(owner.id, p1.id, { title: "任务A", assigneeId: student.id });
    await createTask(owner.id, p2.id, { title: "任务B", assigneeId: student.id });

    const list = await listMyTasks(student.id);
    expect(list).toHaveLength(2);
    expect(new Set(list.map((t) => t.projectName))).toEqual(new Set(["项目一", "项目二"]));
    expect(list.every((t) => t.role === "student")).toBe(true);
  });

  it("只含分配给我的任务", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "我的", assigneeId: student.id });
    await createTask(owner.id, project.id, { title: "别人的", assigneeId: owner.id });

    const list = await listMyTasks(student.id);
    expect(list.map((t) => t.title)).toEqual(["我的"]);
  });

  it("未加入任何团队返回空", async () => {
    const loner = await makeUser("loner@example.com");
    expect(await listMyTasks(loner.id)).toEqual([]);
  });

  it("归档项目的任务排除", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "旧任务", assigneeId: student.id });
    await updateProject(owner.id, project.id, { status: "archived" });

    expect(await listMyTasks(student.id)).toEqual([]);
  });

  it("teacher 被指派时角色带出（前端据此禁拖）", async () => {
    const { owner, teacher, project } = await scene();
    await createTask(owner.id, project.id, { title: "评审", assigneeId: teacher.id });

    const list = await listMyTasks(teacher.id);
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe("teacher");
  });

  it("子任务不进工作台看板（只显示父任务）", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父任务", assigneeId: student.id });
    await createSubtask(owner.id, parent.id, {
      title: "子任务",
      assigneeId: student.id,
      dueDate: "2026-10-15",
    });

    const list = await listMyTasks(student.id);
    expect(list.map((t) => t.title)).toEqual(["父任务"]);
  });

  it("按截止日升序排列，无截止日排最后", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "无期", assigneeId: student.id });
    await createTask(owner.id, project.id, {
      title: "晚",
      assigneeId: student.id,
      dueDate: "2026-03-01",
    });
    await createTask(owner.id, project.id, {
      title: "早",
      assigneeId: student.id,
      dueDate: "2026-01-10",
    });

    expect((await listMyTasks(student.id)).map((t) => t.title)).toEqual(["早", "晚", "无期"]);
  });
});

describe("moveTaskAction 经工作台复用", () => {
  it("未登录拒绝且不改库", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });

    authMock.userId = null;
    const res = await moveTaskAction({
      taskId: task.id,
      projectId: project.id,
      patch: { status: "doing" },
    });
    expect(res).toEqual({ error: "请先登录" });
    expect(await taskStatus(task.id)).toBe("todo");
  });

  it("student 拖拽成功：改库并 revalidate 项目路径", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });

    const calls: unknown[][] = [];
    revalidateMock.fn = (...a: unknown[]) => calls.push(a);
    authMock.userId = student.id;
    const res = await moveTaskAction({
      taskId: task.id,
      projectId: project.id,
      patch: { status: "doing" },
    });
    expect(res).toBeNull();
    expect(await taskStatus(task.id)).toBe("doing");
    expect(calls.some((c) => c[0] === `/projects/${project.id}`)).toBe(true);
  });

  it("teacher 与非成员均被拒且不改库", async () => {
    const { owner, student, teacher, outsider, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });

    authMock.userId = teacher.id;
    expect(
      await moveTaskAction({ taskId: task.id, projectId: project.id, patch: { status: "doing" } }),
    ).toEqual({ error: "没有权限执行此操作" });

    authMock.userId = outsider.id;
    expect(
      await moveTaskAction({ taskId: task.id, projectId: project.id, patch: { status: "doing" } }),
    ).toEqual({ error: "没有权限执行此操作" });
    expect(await taskStatus(task.id)).toBe("todo");
  });

  it("非法 status 与空补丁均报参数无效", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    authMock.userId = student.id;

    expect(
      await moveTaskAction({
        taskId: task.id,
        projectId: project.id,
        // @ts-expect-error 蓄意传入非法枚举值
        patch: { status: "archived" },
      }),
    ).toEqual({ error: "参数无效" });
    expect(
      await moveTaskAction({ taskId: task.id, projectId: project.id, patch: {} }),
    ).toEqual({ error: "参数无效" });
    expect(await taskStatus(task.id)).toBe("todo");
  });
});

describe("listMyTaskActivities", () => {
  it("带出任务/项目/操作人信息且最新在前", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "调研报告", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });

    const feed = await listMyTaskActivities(student.id);
    expect(feed).toHaveLength(2);
    expect(feed[0].type).toBe("field");
    expect(feed[0].actorName).toBe("student");
    expect(feed[1].type).toBe("created");
    expect(feed[1].actorName).toBe("owner");
    expect(feed[0].taskId).toBe(task.id);
    expect(feed[0].taskTitle).toBe("调研报告");
    expect(feed[0].projectId).toBe(project.id);
    expect(feed[0].projectName).toBe("赤壁演习");
  });

  it("只含分配给我的任务的动态", async () => {
    const { owner, student, project } = await scene();
    const mine = await createTask(owner.id, project.id, { title: "我的", assigneeId: student.id });
    await createTask(owner.id, project.id, { title: "别人的", assigneeId: owner.id });

    const feed = await listMyTaskActivities(student.id);
    expect(feed.every((a) => a.taskId === mine.id)).toBe(true);
  });

  it("非成员返回空", async () => {
    const { owner, student, outsider, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    expect(await listMyTaskActivities(outsider.id)).toEqual([]);
  });

  it("归档项目的动态排除", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateProject(owner.id, project.id, { status: "archived" });
    expect(await listMyTaskActivities(student.id)).toEqual([]);
  });

  it("子任务自身动态与父任务 subtask_done 都进 feed", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父", assigneeId: student.id });
    const sub = await createSubtask(owner.id, parent.id, {
      title: "子",
      assigneeId: student.id,
    });
    await updateTask(student.id, sub.id, { status: "done" });

    const feed = await listMyTaskActivities(student.id);
    const subtaskDone = feed.find((a) => a.type === "subtask_done");
    expect(subtaskDone?.taskId).toBe(parent.id);
    expect(feed.some((a) => a.taskId === sub.id && a.type === "field")).toBe(true);
  });

  it("默认 limit 20", async () => {
    const { owner, student, project } = await scene();
    for (let i = 0; i < 25; i++) {
      await createTask(owner.id, project.id, { title: `任务${i}`, assigneeId: student.id });
    }
    expect(await listMyTaskActivities(student.id)).toHaveLength(20);
  });
});

describe("listProjectActivities", () => {
  it("只含本项目任务的动态且最新在前", async () => {
    const { owner, student, project, team } = await scene();
    const other = await createProject(owner.id, team.id, { name: "官渡之战" });
    const task = await createTask(owner.id, project.id, { title: "本项目", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });
    await createTask(owner.id, other.id, { title: "他项目", assigneeId: student.id });

    const feed = await listProjectActivities(student.id, project.id);
    expect(feed.every((a) => a.projectId === project.id)).toBe(true);
    expect(feed).toHaveLength(2);
    expect(feed[0].type).toBe("field");
    expect(feed[1].type).toBe("created");
    expect(feed[0].projectName).toBe("赤壁演习");
    expect(feed[0].taskTitle).toBe("本项目");
  });

  it("不限「分配给我」：他人任务的动态也在内", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "别人的", assigneeId: owner.id });

    const feed = await listProjectActivities(student.id, project.id);
    expect(feed).toHaveLength(1);
    expect(feed[0].taskTitle).toBe("别人的");
  });

  it("非成员抛 ForbiddenError", async () => {
    const { owner, student, outsider, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await expect(listProjectActivities(outsider.id, project.id)).rejects.toThrow(ForbiddenError);
  });

  it("归档项目仍可读历史动态", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateProject(owner.id, project.id, { status: "archived" });
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(1);
  });

  it("默认 limit 20", async () => {
    const { owner, student, project } = await scene();
    for (let i = 0; i < 25; i++) {
      await createTask(owner.id, project.id, { title: `任务${i}`, assigneeId: student.id });
    }
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(20);
  });
});

describe("动态流未读", () => {
  it("无已读标记视为全部已读", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(0);
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(0);
  });

  it("标记已读后的新动态计入未读", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await markFeedRead(student.id, WORKBENCH_SCOPE);
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(0);

    await updateTask(student.id, task.id, { status: "doing" });
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(1);
  });

  it("再次标记已读后清空，新动态重新累计", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await markFeedRead(student.id, WORKBENCH_SCOPE);
    await updateTask(student.id, task.id, { status: "doing" });
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(1);

    await markFeedRead(student.id, WORKBENCH_SCOPE);
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(0);
    // 学生完成已被审批流拦截（approval.test.ts 专测）；这里只为制造状态动态，由 admin 完成等效
    await updateTask(owner.id, task.id, { status: "done" });
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(1);
  });

  it("workbench 与 project scope 互不影响", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await markFeedRead(student.id, WORKBENCH_SCOPE);

    await updateTask(student.id, task.id, { status: "doing" });
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(1);
    // 项目 scope 尚无标记，不因工作台已读而受影响
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(0);

    await markFeedRead(student.id, projectFeedScope(project.id));
    // 学生完成已被审批流拦截（approval.test.ts 专测）；这里只为制造状态动态，由 admin 完成等效
    await updateTask(owner.id, task.id, { status: "done" });
    // 工作台此后未再读，两条新动态都累计；项目 scope 只累计自己标记后的一条
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(2);
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(1);
  });

  it("project scope 只计本项目动态", async () => {
    const { owner, student, project, team } = await scene();
    const other = await createProject(owner.id, team.id, { name: "官渡之战" });
    const task = await createTask(owner.id, project.id, { title: "本项目", assigneeId: student.id });
    const otherTask = await createTask(owner.id, other.id, { title: "他项目", assigneeId: student.id });
    await markFeedRead(student.id, projectFeedScope(project.id));

    await updateTask(student.id, task.id, { status: "doing" });
    await updateTask(student.id, otherTask.id, { status: "doing" });
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(1);
  });

  it("task scope 只计该任务动态", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    const other = await createTask(owner.id, project.id, { title: "O", assigneeId: student.id });
    await markFeedRead(student.id, taskFeedScope(task.id));

    await updateTask(student.id, task.id, { status: "doing" });
    await updateTask(student.id, other.id, { status: "doing" });
    expect(await getFeedUnreadCount(student.id, taskFeedScope(task.id))).toBe(1);
    // 项目 scope 尚无标记，不因任务 scope 已读而受影响
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(0);
  });

  it("markFeedReadAction 校验 scope 白名单", async () => {
    const { owner, student, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    authMock.userId = student.id;

    await markFeedReadAction("project:not-a-uuid");
    await markFeedReadAction("task:not-a-uuid");
    await markFeedReadAction(`${WORKBENCH_SCOPE}; drop`);
    // 非法 scope 不落库
    expect(await db.select().from(feedReads)).toHaveLength(0);

    await markFeedReadAction(WORKBENCH_SCOPE);
    const [marker] = await db
      .select()
      .from(feedReads)
      .where(and(eq(feedReads.userId, student.id), eq(feedReads.scope, WORKBENCH_SCOPE)));
    expect(marker).toBeDefined();
    expect(await getFeedUnreadCount(student.id, WORKBENCH_SCOPE)).toBe(0);
  });

  it("标记已读后同一毫秒内的旧动态不再计未读（比较不丢微秒精度）", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    const scope = projectFeedScope(project.id);
    await markFeedRead(student.id, scope);

    // 把已读时刻拨到该动态同一毫秒的末尾（微秒比动态更晚）：动态在标记之前，理当不计未读；
    // 旧实现把 last_read_at 读到 JS 丢微秒后再比较，会把它漏计成 1（角标清不掉的偶发根因）
    await db.execute(
      sql`update feed_reads set last_read_at = (select date_trunc('milliseconds', created_at) + interval '999 microseconds' from task_activities where task_id = ${task.id}) where user_id = ${student.id} and scope = ${scope}`,
    );
    expect(await getFeedUnreadCount(student.id, scope)).toBe(0);
  });
});

describe("clearFeed（清除记录只清自己视角）", () => {
  it("清除后自己看到的动态流为空，库内数据与他人视图不动", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });
    await updateTask(owner.id, task.id, { status: "done" });
    await markFeedRead(student.id, projectFeedScope(project.id));
    await updateTask(student.id, task.id, { status: "todo" });
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(1);

    await clearFeed(student.id, projectFeedScope(project.id));

    // 学生自己的视角被清空，未读同时归零
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(0);
    // 其他人的视角不受影响：owner 仍能看到全部 4 条
    expect(await listProjectActivities(owner.id, project.id)).toHaveLength(4);
    // 库内数据一条没删
    expect(await db.select().from(taskActivities)).toHaveLength(4);
  });

  it("清除后新产生的记录照常显示、重新计未读", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });

    await clearFeed(student.id, projectFeedScope(project.id));
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);

    // 学生完成已被审批流拦截（approval.test.ts 专测）；这里只为制造状态动态，由 admin 完成等效
    await updateTask(owner.id, task.id, { status: "done" });
    const feed = await listProjectActivities(student.id, project.id);
    expect(feed).toHaveLength(1);
    expect(feed[0].type).toBe("field");
    expect(feed[0].field).toBe("状态");
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(1);
  });

  it("task 与 project 两条流各自清除、互不影响", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });

    await clearFeed(student.id, taskFeedScope(task.id));
    // 任务时间线清空；项目流（同项目的全部动态）原样
    expect(await listTaskActivities(student.id, task.id)).toHaveLength(0);
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(2);

    await clearFeed(student.id, projectFeedScope(project.id));
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);
    // 任务时间线不受项目流清除影响（仍是清空后的状态）
    expect(await listTaskActivities(student.id, task.id)).toHaveLength(0);
  });

  it("清除时刻同一毫秒内的旧动态也被隐藏（比较不丢微秒精度）", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await clearFeed(student.id, taskFeedScope(task.id));

    // 把清除时刻拨到该动态同一毫秒的末尾（微秒比动态更晚）：动态在清除之前，理当隐藏；
    // 旧实现把 cleared_at 读到 JS 丢微秒后再比较，会把它漏成可见（CI 偶发挂掉的根因）
    await db.execute(
      sql`update feed_reads set cleared_at = (select date_trunc('milliseconds', created_at) + interval '999 microseconds' from task_activities where task_id = ${task.id}) where user_id = ${student.id} and scope = ${taskFeedScope(task.id)}`,
    );
    expect(await listTaskActivities(student.id, task.id)).toHaveLength(0);
  });

  it("workbench 与 project 两条流各自清除、互不影响", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });

    await clearFeed(student.id, projectFeedScope(project.id));
    // 项目流清空；工作台流（分配给我的全部动态）原样
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);
    expect(await listMyTaskActivities(student.id)).toHaveLength(2);

    await clearFeed(student.id, WORKBENCH_SCOPE);
    expect(await listMyTaskActivities(student.id)).toHaveLength(0);
    // 项目流不受工作台清除影响（仍是清空后的状态）
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);
  });

  it("clearFeedAction 校验登录与 scope 白名单，清除落库 clearedAt", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    const scope = projectFeedScope(project.id);

    authMock.userId = null;
    expect(await clearFeedAction(scope)).toEqual({ error: "请先登录" });

    authMock.userId = student.id;
    expect(await clearFeedAction("project:not-a-uuid")).toEqual({ error: "参数无效" });
    expect(await clearFeedAction("task:not-a-uuid")).toEqual({ error: "参数无效" });
    expect(await clearFeedAction(`${WORKBENCH_SCOPE}; drop`)).toEqual({ error: "参数无效" });
    // 非法 scope 不落库
    expect(await db.select().from(feedReads)).toHaveLength(0);

    expect(await clearFeedAction(scope)).toBeNull();
    const [marker] = await db
      .select()
      .from(feedReads)
      .where(and(eq(feedReads.userId, student.id), eq(feedReads.scope, scope)));
    expect(marker?.clearedAt).toBeInstanceOf(Date);
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);

    // task scope 走同一白名单与清除逻辑，并按 taskId 反查项目路径 revalidate
    revalidateMock.fn = vi.fn();
    expect(await clearFeedAction(taskFeedScope(task.id))).toBeNull();
    expect(await listTaskActivities(student.id, task.id)).toHaveLength(0);
    expect(revalidateMock.fn).toHaveBeenCalledWith(`/projects/${project.id}/tasks/${task.id}`);
  });
});

describe("deleteActivityForUser（单条删除）", () => {
  async function activityCount(taskId: string) {
    const rows = await db
      .select({ id: taskActivities.id })
      .from(taskActivities)
      .where(eq(taskActivities.taskId, taskId));
    return rows.length;
  }

  it("普通成员只隐藏自己的视图，库与他人视图不动，重复删除幂等", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await updateTask(student.id, task.id, { status: "doing" });

    const [latest] = await listProjectActivities(student.id, project.id);
    expect(latest.canPurge).toBe(false);

    expect(await deleteActivityForUser(student.id, latest.id)).toBe("self");
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(1);
    expect(await listProjectActivities(owner.id, project.id)).toHaveLength(2);
    expect(await activityCount(task.id)).toBe(2);

    // 再删一次不报错，视图也不再多消失
    expect(await deleteActivityForUser(student.id, latest.id)).toBe("self");
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(1);
  });

  it("团队管理员直接删库，所有人的视图一起消失", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    const [only] = await listProjectActivities(owner.id, project.id);
    expect(only.canPurge).toBe(true);

    expect(await deleteActivityForUser(owner.id, only.id)).toBe("all");
    expect(await activityCount(task.id)).toBe(0);
    expect(await listProjectActivities(owner.id, project.id)).toHaveLength(0);
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);
  });

  it("非成员无权删除", async () => {
    const { owner, student, outsider, project } = await scene();
    await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    const [only] = await listProjectActivities(student.id, project.id);
    await expect(deleteActivityForUser(outsider.id, only.id)).rejects.toThrow(ForbiddenError);
  });

  it("隐藏的单条不再计入未读", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    await markFeedRead(student.id, projectFeedScope(project.id));
    await updateTask(student.id, task.id, { status: "doing" });
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(1);

    const [latest] = await listProjectActivities(student.id, project.id);
    await deleteActivityForUser(student.id, latest.id);
    expect(await getFeedUnreadCount(student.id, projectFeedScope(project.id))).toBe(0);
  });

  it("deleteActivityAction 校验登录与参数，成功后按 scope 回流页面", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "T", assigneeId: student.id });
    const [only] = await listProjectActivities(student.id, project.id);
    const scope = projectFeedScope(project.id);

    authMock.userId = null;
    expect(await deleteActivityAction(only.id, scope)).toEqual({ error: "请先登录" });

    authMock.userId = student.id;
    expect(await deleteActivityAction("not-a-uuid", scope)).toEqual({ error: "参数无效" });
    expect(await deleteActivityAction(only.id, "project:not-a-uuid")).toEqual({ error: "参数无效" });

    revalidateMock.fn = vi.fn();
    expect(await deleteActivityAction(only.id, scope)).toEqual({ ok: true, mode: "self" });
    expect(revalidateMock.fn).toHaveBeenCalledWith(`/projects/${project.id}`);
    expect(await listProjectActivities(student.id, project.id)).toHaveLength(0);
    expect(await activityCount(task.id)).toBe(1);
  });
});

describe("listMySubtaskProgress", () => {
  it("按父任务聚合总数与完成数", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父", assigneeId: student.id });
    const s1 = await createSubtask(owner.id, parent.id, { title: "子1", assigneeId: student.id });
    const s2 = await createSubtask(owner.id, parent.id, { title: "子2", assigneeId: student.id });
    await createSubtask(owner.id, parent.id, { title: "子3", assigneeId: student.id });
    await updateTask(student.id, s1.id, { status: "done" });
    await updateTask(student.id, s2.id, { status: "done" });

    const rows = await listMySubtaskProgress([parent.id]);
    expect(rows).toEqual([{ parentTaskId: parent.id, total: 3, done: 2 }]);
  });

  it("只算直接子级不递归", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父", assigneeId: student.id });
    const sub = await createSubtask(owner.id, parent.id, { title: "子", assigneeId: student.id });
    await createSubtask(owner.id, sub.id, { title: "孙", assigneeId: student.id });

    const rows = await listMySubtaskProgress([parent.id]);
    expect(rows).toEqual([{ parentTaskId: parent.id, total: 1, done: 0 }]);
  });

  it("空 id 列表返回空数组", async () => {
    expect(await listMySubtaskProgress([])).toEqual([]);
  });

  it("无子任务的父任务不产生行；他人负责的子任务也计入", async () => {
    const { owner, student, project } = await scene();
    const childless = await createTask(owner.id, project.id, { title: "无子", assigneeId: student.id });
    const parent = await createTask(owner.id, project.id, { title: "父", assigneeId: student.id });
    // 子任务指派给 owner（非学生）：父任务进度看整体，不按子任务负责人过滤
    await createSubtask(owner.id, parent.id, { title: "子", assigneeId: owner.id });

    const rows = await listMySubtaskProgress([childless.id, parent.id]);
    expect(rows.find((r) => r.parentTaskId === childless.id)).toBeUndefined();
    expect(rows.find((r) => r.parentTaskId === parent.id)?.total).toBe(1);
  });
});

describe("workbench 纯函数", () => {
  it("pickProjectFilter 只认出现过的项目", () => {
    const tasks = [
      { projectId: "11111111-1111-4111-8111-111111111111" },
      { projectId: "22222222-2222-4222-8222-222222222222" },
    ];
    expect(pickProjectFilter(tasks[0].projectId, tasks)).toBe(tasks[0].projectId);
    expect(pickProjectFilter("33333333-3333-4333-8333-333333333333", tasks)).toBeNull();
    expect(pickProjectFilter("abc", tasks)).toBeNull();
    expect(pickProjectFilter(["x"], tasks)).toBeNull();
    expect(pickProjectFilter(undefined, tasks)).toBeNull();
  });

  it("dashboardHref 双参数互不覆盖", () => {
    expect(dashboardHref({ hideDone: true, project: "x" })).toBe(
      "/dashboard?hideDone=1&project=x",
    );
    expect(dashboardHref({ hideDone: false, project: null })).toBe("/dashboard");
    expect(dashboardHref({ hideDone: true, project: null })).toBe("/dashboard?hideDone=1");
    expect(dashboardHref({ project: "x" })).toBe("/dashboard?project=x");
  });

  it("projectChips 按首次出现顺序去重", () => {
    const chips = projectChips([
      { projectId: "a", projectName: "甲" },
      { projectId: "b", projectName: "乙" },
      { projectId: "a", projectName: "甲" },
    ]);
    expect(chips).toEqual([
      { id: "a", name: "甲" },
      { id: "b", name: "乙" },
    ]);
  });
});
