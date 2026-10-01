import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, createSubtask, updateTask, deleteTask, listSubtasks } from "@/lib/task";
import { createLabel } from "@/lib/label";
import {
  listAttachments,
  uploadAttachment,
  deleteAttachment,
  ATTACHMENT_MAX_SIZE,
} from "@/lib/attachment";
import { listTaskActivities } from "@/lib/activity";
import { ForbiddenError } from "@/lib/errors";
import { db } from "@/db";
import { tasks as tasksTable, taskDependencies, taskLabels, milestones } from "@/db/schema";
import { GET as downloadGET } from "@/app/api/attachments/[attachmentId]/route";
import {
  toggleSubtaskDoneAction,
  addSubtaskAction,
  deleteSubtaskAction,
  deleteTaskFromDetailAction,
  uploadAttachmentAction,
  deleteAttachmentAction,
  type FormState,
} from "@/app/(app)/projects/[projectId]/tasks/[taskId]/actions";
import {
  updateTaskAction,
  type UpdateTaskState,
} from "@/app/(app)/projects/[projectId]/actions";
import { resetDb } from "./helpers";

// 详情页 actions 走 auth() 与 revalidatePath，须 mock（本仓首例测 app 层 action）
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
// 默认空实现须接受可变参数（tsc 展开要求），void a 防 lint 未用告警
const revalidateMock = vi.hoisted(() => ({ fn: (...a: unknown[]) => { void a; } }));
// redirect 语义上必抛 NEXT_REDIRECT，mock 须同样抛出，delete action 才会以异常收尾。
// 返回类型标 void：记录用例的覆写以 push 收尾（返回 number），不可与默认实现的 never 推断冲突
const navMock = vi.hoisted(() => ({
  fn: ((...a: unknown[]) => {
    void a;
    throw new Error("NEXT_REDIRECT");
  }) as (...a: unknown[]) => void,
}));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidateMock.fn(...a) }));
// deleteTaskFromDetailAction 成功路径以 redirect 收尾，mock 之记录跳转目标
vi.mock("next/navigation", () => ({ redirect: (...a: unknown[]) => navMock.fn(...a) }));
// updateTask 置 done 会 fire-and-forget 飞书通知，mock 掉免外呼
vi.mock("@/lib/feishu", () => ({ sendCardMessage: async () => {} }));

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.append(k, v);
  return fd;
}

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
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
  const parent = await createTask(student.id, project.id, { title: " parent 任务" });
  return { owner, team, student, teacher, outsider, project, parent };
}

beforeEach(async () => {
  await resetDb();
  authMock.userId = null;
  revalidateMock.fn = () => {};
  // navMock 不重置：默认即 faithful 抛错语义，需记录调用处的用例自行覆盖
});

describe("附件 lib", () => {
  it("上传后列表可见且不含二进制内容", async () => {
    const { student, parent } = await scene();
    await uploadAttachment(student.id, parent.id, {
      filename: "调研报告.txt",
      mimeType: "text/plain",
      size: 5,
      data: Buffer.from("hello"),
    });
    const list = await listAttachments(student.id, parent.id);
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("调研报告.txt");
    expect(list[0].size).toBe(5);
    expect(list[0].uploaderName).toBe("student");
    expect((list[0] as unknown as Record<string, unknown>).data).toBeUndefined();
  });

  it("超过 10MB 拒收", async () => {
    const { student, parent } = await scene();
    await expect(
      uploadAttachment(student.id, parent.id, {
        filename: "big.bin",
        size: ATTACHMENT_MAX_SIZE + 1,
        data: Buffer.alloc(ATTACHMENT_MAX_SIZE + 1),
      }),
    ).rejects.toThrow("附件不能超过 10MB");
  });

  it("teacher 不可上传、可下载；非成员全被拒", async () => {
    const { owner, student, teacher, outsider, parent } = await scene();
    const { id } = await uploadAttachment(student.id, parent.id, {
      filename: "a.txt",
      mimeType: "text/plain",
      size: 2,
      data: Buffer.from("hi"),
    });
    await expect(
      uploadAttachment(teacher.id, parent.id, {
        filename: "b.txt",
        size: 2,
        data: Buffer.from("hi"),
      }),
    ).rejects.toThrow(ForbiddenError);
    await expect(
      uploadAttachment(outsider.id, parent.id, {
        filename: "c.txt",
        size: 2,
        data: Buffer.from("hi"),
      }),
    ).rejects.toThrow(ForbiddenError);
    // teacher 可取回下载内容
    const got = await (await import("@/lib/attachment")).getAttachmentForDownload(
      teacher.id,
      id,
    );
    expect(got.data.toString()).toBe("hi");
    await expect(
      (await import("@/lib/attachment")).getAttachmentForDownload(outsider.id, id),
    ).rejects.toThrow(ForbiddenError);
    void owner;
  });

  it("下载路由：成员 200 且强制 attachment 响应，非成员 403，未登录 401", async () => {
    const { student, outsider, parent } = await scene();
    const { id } = await uploadAttachment(student.id, parent.id, {
      filename: "报告 v1.txt",
      mimeType: "text/plain",
      size: 2,
      data: Buffer.from("hi"),
    });

    authMock.userId = student.id;
    const res = await downloadGET(
      new Request(`http://localhost/api/attachments/${id}`),
      { params: Promise.resolve({ attachmentId: id }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(await res.text()).toBe("hi");

    authMock.userId = outsider.id;
    const forbidden = await downloadGET(
      new Request(`http://localhost/api/attachments/${id}`),
      { params: Promise.resolve({ attachmentId: id }) },
    );
    expect(forbidden.status).toBe(403);

    authMock.userId = null;
    const unauth = await downloadGET(
      new Request(`http://localhost/api/attachments/${id}`),
      { params: Promise.resolve({ attachmentId: id }) },
    );
    expect(unauth.status).toBe(401);
  });

  it("删除后列表为空", async () => {
    const { student, parent } = await scene();
    const { id } = await uploadAttachment(student.id, parent.id, {
      filename: "a.txt",
      size: 2,
      data: Buffer.from("hi"),
    });
    await deleteAttachment(student.id, id);
    expect(await listAttachments(student.id, parent.id)).toHaveLength(0);
  });
});

describe("动态 lib", () => {
  it("创建/字段变更/子任务增删改均在两条时间线留痕", async () => {
    const { owner, student, parent, project } = await scene();

    await updateTask(student.id, parent.id, { status: "done" });
    const acts = await listTaskActivities(student.id, parent.id);
    // created + 状态变更
    expect(acts.some((a) => a.type === "created" && a.actorName === "student")).toBe(true);
    const statusAct = acts.find((a) => a.type === "field" && a.field === "状态");
    expect(statusAct?.oldValue).toBe("待办");
    expect(statusAct?.newValue).toBe("已完成");

    // 改派记人名而非裸 id
    await updateTask(student.id, parent.id, { status: "todo", assigneeId: owner.id });
    const acts2 = await listTaskActivities(student.id, parent.id);
    const assigneeAct = acts2.find((a) => a.type === "field" && a.field === "负责人");
    expect(assigneeAct?.oldValue).toBe("未分配");
    expect(assigneeAct?.newValue).toBe("owner");

    // 子任务：父任务记 subtask_added，子任务自身记 created；勾完成父任务记 subtask_done
    const sub = await createSubtask(student.id, parent.id, { title: "搭建环境" });
    const parentActs = await listTaskActivities(student.id, parent.id);
    expect(parentActs[0].type).toBe("subtask_added");
    expect(parentActs[0].newValue).toBe("搭建环境");
    await updateTask(student.id, sub.id, { status: "done" });
    const parentActs2 = await listTaskActivities(student.id, parent.id);
    expect(parentActs2[0].type).toBe("subtask_done");

    // 删除子任务前先记 subtask_deleted
    await deleteTask(student.id, sub.id);
    const parentActs3 = await listTaskActivities(student.id, parent.id);
    expect(parentActs3[0].type).toBe("subtask_deleted");
    void project;
  });

  it("附件增删留痕；非成员读动态被拒", async () => {
    const { student, outsider, parent } = await scene();
    const { id } = await uploadAttachment(student.id, parent.id, {
      filename: "a.txt",
      size: 2,
      data: Buffer.from("hi"),
    });
    const acts = await listTaskActivities(student.id, parent.id);
    expect(acts[0].type).toBe("attachment_added");
    expect(acts[0].newValue).toBe("a.txt");
    await deleteAttachment(student.id, id);
    const acts2 = await listTaskActivities(student.id, parent.id);
    expect(acts2[0].type).toBe("attachment_deleted");

    await expect(listTaskActivities(outsider.id, parent.id)).rejects.toThrow(ForbiddenError);
  });
});

describe("详情页 server actions", () => {
  it("勾选/取消勾选子任务", async () => {
    const { student, owner, parent, project } = await scene();
    const sub = await createSubtask(student.id, parent.id, { title: "子A" });
    authMock.userId = student.id;
    const fd = formData({ projectId: project.id, taskId: parent.id, subtaskId: sub.id });

    fd.append("done", "1");
    expect(await toggleSubtaskDoneAction(null, fd)).toBeNull();
    expect((await listSubtasks(student.id, parent.id))[0].status).toBe("done");

    const fd2 = formData({ projectId: project.id, taskId: parent.id, subtaskId: sub.id });
    expect(await toggleSubtaskDoneAction(null, fd2)).toBeNull();
    expect((await listSubtasks(student.id, parent.id))[0].status).toBe("todo");
    void owner;
  });

  it("teacher 勾选被拒，未登录提示登录，非法 uuid 报校验错", async () => {
    const { student, teacher, parent, project } = await scene();
    const sub = await createSubtask(student.id, parent.id, { title: "子A" });

    authMock.userId = teacher.id;
    const teacherRes = await toggleSubtaskDoneAction(
      null,
      formData({ projectId: project.id, taskId: parent.id, subtaskId: sub.id, done: "1" }),
    );
    expect((teacherRes as { error: string }).error).toBe("没有权限修改任务");
    expect((await listSubtasks(student.id, parent.id))[0].status).toBe("todo");

    authMock.userId = null;
    const unauth = await toggleSubtaskDoneAction(
      null,
      formData({ projectId: project.id, taskId: parent.id, subtaskId: sub.id, done: "1" }),
    );
    expect((unauth as { error: string }).error).toBe("请先登录");

    authMock.userId = student.id;
    const bad = await toggleSubtaskDoneAction(
      null,
      formData({ projectId: "not-uuid", taskId: parent.id, subtaskId: sub.id, done: "1" }),
    );
    expect((bad as { error: string }).error).toBeTruthy();
  });

  it("添加与删除子任务", async () => {
    const { student, teacher, parent, project } = await scene();
    authMock.userId = student.id;
    const base = { projectId: project.id, taskId: parent.id };

    expect(await addSubtaskAction(null, formData({ ...base, title: "新子任务" }))).toBeNull();
    expect(await addSubtaskAction(null, formData({ ...base, title: "  " }))).toEqual({
      error: "请填写子任务标题",
    });
    let subs = await listSubtasks(student.id, parent.id);
    expect(subs).toHaveLength(1);

    authMock.userId = teacher.id;
    const denied = await addSubtaskAction(null, formData({ ...base, title: "x" }));
    expect((denied as { error: string }).error).toBe("没有权限创建任务");

    authMock.userId = student.id;
    await deleteSubtaskAction(null, formData({ ...base, subtaskId: subs[0].id }));
    subs = await listSubtasks(student.id, parent.id);
    expect(subs).toHaveLength(0);

    // teacher 删除被拒：再造一条子任务给 teacher 试删
    authMock.userId = student.id;
    const sub2 = await createSubtask(student.id, parent.id, { title: "子B" });
    authMock.userId = teacher.id;
    const delDenied = await deleteSubtaskAction(
      null,
      formData({ ...base, subtaskId: sub2.id }),
    );
    expect((delDenied as { error: string }).error).toBe("没有权限删除任务");
    expect(await listSubtasks(student.id, parent.id)).toHaveLength(1);
  });

  it("添加子任务支持描述/优先级/里程碑（与新建任务同口径）", async () => {
    const { owner, student, parent, project, team } = await scene();
    const [ms] = await db
      .insert(milestones)
      .values({ projectId: project.id, title: "终期答辩" })
      .returning();

    authMock.userId = student.id;
    const res = await addSubtaskAction(
      null,
      formData({
        projectId: project.id,
        taskId: parent.id,
        title: "带描述的子任务",
        description: "搭好环境后再跑通冒烟",
        priority: "high",
        milestoneId: ms.id,
      }),
    );
    expect(res).toBeNull();

    const [sub] = await listSubtasks(student.id, parent.id);
    expect(sub.title).toBe("带描述的子任务");
    expect(sub.description).toBe("搭好环境后再跑通冒烟");
    expect(sub.priority).toBe("high");
    expect(sub.milestoneId).toBe(ms.id);

    // 他项目的里程碑挂不上（createTask 校验里程碑属本项目）
    const other = await createProject(owner.id, team.id, { name: "别处" });
    const [otherMs] = await db
      .insert(milestones)
      .values({ projectId: other.id, title: "别人的里程碑" })
      .returning();
    const bad = await addSubtaskAction(
      null,
      formData({
        projectId: project.id,
        taskId: parent.id,
        title: "x",
        milestoneId: otherMs.id,
      }),
    );
    expect((bad as { error: string }).error).toBe("里程碑不属于该项目");
  });

  it("上传/删除附件 action 与 revalidate 路径", async () => {
    const { student, parent, project } = await scene();
    authMock.userId = student.id;
    const base = { projectId: project.id, taskId: parent.id };

    const calls: unknown[][] = [];
    revalidateMock.fn = (...a: unknown[]) => calls.push(a);
    const fd = formData(base);
    fd.append("file", new File([Buffer.from("hi")], "附件.txt", { type: "text/plain" }));
    expect(await uploadAttachmentAction(null, fd)).toBeNull();
    expect(calls.some((c) => c[0] === `/projects/${project.id}/tasks/${parent.id}`)).toBe(true);
    expect(
      calls.some((c) => c[0] === `/projects/${project.id}`),
    ).toBe(true);

    const list = await listAttachments(student.id, parent.id);
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe("附件.txt");

    const noFile = await uploadAttachmentAction(null, formData(base));
    expect((noFile as { error: string }).error).toBe("请选择要上传的文件");

    await deleteAttachmentAction(null, formData({ ...base, attachmentId: list[0].id }));
    expect(await listAttachments(student.id, parent.id)).toHaveLength(0);
  });

  it("FormState 空态为 null", () => {
    const x: FormState = null;
    expect(x).toBeNull();
  });
});

// 编辑功能自看板迁入详情页：updateTaskAction 复用项目页 action，删除走详情页新 action
describe("任务编辑/删除 action（详情页）", () => {
  async function editScene() {
    const s = await scene();
    // 标签归团队，创建须 admin（owner）
    const label = await createLabel(s.owner.id, s.team.id, { name: "先锋" });
    const successorA = await createTask(s.owner.id, s.project.id, { title: "后置甲" });
    const successorB = await createTask(s.owner.id, s.project.id, { title: "后置乙" });
    return { ...s, label, successorA, successorB };
  }

  function editForm(base: { projectId: string; taskId: string }, overrides?: Record<string, string>) {
    const fd = new FormData();
    fd.append("taskId", base.taskId);
    fd.append("projectId", base.projectId);
    fd.append("title", "改编后的任务");
    fd.append("description", "更新后的描述");
    fd.append("priority", "high");
    fd.append("dueDate", "2026-11-01");
    for (const [k, v] of Object.entries(overrides ?? {})) fd.append(k, v);
    return fd;
  }

  it("student 全量编辑成功：任务/后置边/标签落库并 revalidate 项目路径", async () => {
    const { student, parent, project, label, successorA, successorB } = await editScene();
    authMock.userId = student.id;

    const calls: unknown[][] = [];
    revalidateMock.fn = (...a: unknown[]) => calls.push(a);
    const fd = editForm({ projectId: project.id, taskId: parent.id });
    fd.append("successorIds", successorA.id);
    fd.append("successorIds", successorB.id);
    fd.append("labelIds", label.id);

    const res = await updateTaskAction(null, fd);
    expect(res).toEqual({ ok: true });

    const [row] = await db
      .select({ title: tasksTable.title, description: tasksTable.description, priority: tasksTable.priority })
      .from(tasksTable)
      .where(eq(tasksTable.id, parent.id));
    expect(row?.title).toBe("改编后的任务");
    expect(row?.priority).toBe("high");

    const deps = await db
      .select({ successorId: taskDependencies.successorId })
      .from(taskDependencies)
      .where(eq(taskDependencies.predecessorId, parent.id));
    expect(new Set(deps.map((d) => d.successorId))).toEqual(new Set([successorA.id, successorB.id]));

    const lbls = await db
      .select({ labelId: taskLabels.labelId })
      .from(taskLabels)
      .where(eq(taskLabels.taskId, parent.id));
    expect(lbls.map((l) => l.labelId)).toEqual([label.id]);

    expect(calls.some((c) => c[0] === `/projects/${project.id}`)).toBe(true);
  });

  it("teacher 编辑被拒且不改库", async () => {
    const { teacher, parent, project } = await editScene();
    authMock.userId = teacher.id;

    const res = await updateTaskAction(
      null,
      editForm({ projectId: project.id, taskId: parent.id }),
    );
    expect((res as { error: string }).error).toBe("没有权限修改任务");

    const [row] = await db
      .select({ title: tasksTable.title })
      .from(tasksTable)
      .where(eq(tasksTable.id, parent.id));
    expect(row?.title).toBe(" parent 任务");
  });

  it("未登录编辑提示登录", async () => {
    const { parent } = await editScene();
    const res: UpdateTaskState = await updateTaskAction(
      null,
      editForm({ projectId: "11111111-1111-4111-8111-111111111111", taskId: parent.id }),
    );
    expect(res).toEqual({ error: "请先登录" });
  });

  it("student 删除成功：revalidate 两条路径后 redirect 回看板，任务消失", async () => {
    const { student, parent, project } = await editScene();
    authMock.userId = student.id;

    const navCalls: unknown[][] = [];
    navMock.fn = (...a: unknown[]) => {
      navCalls.push(a);
      throw new Error("NEXT_REDIRECT");
    };
    const reCalls: unknown[][] = [];
    revalidateMock.fn = (...a: unknown[]) => reCalls.push(a);

    // redirect 抛 NEXT_REDIRECT，直接 await 会把异常抛回测试
    await expect(
      deleteTaskFromDetailAction(null, formData({ projectId: project.id, taskId: parent.id })),
    ).rejects.toThrow();

    expect(navCalls.some((c) => c[0] === `/projects/${project.id}`)).toBe(true);
    expect(reCalls.some((c) => c[0] === `/projects/${project.id}/tasks/${parent.id}`)).toBe(true);
    expect(reCalls.some((c) => c[0] === `/projects/${project.id}`)).toBe(true);

    const [row] = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, parent.id));
    expect(row).toBeUndefined();
  });

  it("teacher 与未登录删除均被拒，redirect 不触发", async () => {
    const { teacher, parent, project } = await editScene();
    const navCalls: unknown[][] = [];
    navMock.fn = (...a: unknown[]) => navCalls.push(a);

    authMock.userId = teacher.id;
    const denied = await deleteTaskFromDetailAction(
      null,
      formData({ projectId: project.id, taskId: parent.id }),
    );
    expect((denied as { error: string }).error).toBe("没有权限删除任务");

    authMock.userId = null;
    const unauth = await deleteTaskFromDetailAction(
      null,
      formData({ projectId: project.id, taskId: parent.id }),
    );
    expect((unauth as { error: string }).error).toBe("请先登录");

    expect(navCalls).toHaveLength(0);
    const [row] = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, parent.id));
    expect(row).toBeDefined();
  });

  it("非法 uuid 报参数无效，redirect 不触发", async () => {
    const { student, parent } = await editScene();
    authMock.userId = student.id;
    const navCalls: unknown[][] = [];
    navMock.fn = (...a: unknown[]) => navCalls.push(a);

    const bad = await deleteTaskFromDetailAction(
      null,
      formData({ projectId: "not-uuid", taskId: parent.id }),
    );
    expect((bad as { error: string }).error).toBe("参数无效");
    expect(navCalls).toHaveLength(0);
  });
});
