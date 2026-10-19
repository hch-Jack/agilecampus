import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, getTaskDetail, listProjectTasks } from "@/lib/task";
import { createApiToken } from "@/lib/api-token";
import {
  GET as taskDetail,
  PATCH as patchTask,
} from "@/app/api/agent/tasks/[taskId]/route";
import { POST as patchSuccessors } from "@/app/api/agent/tasks/[taskId]/successors/route";
import { GET as listDependencies } from "@/app/api/agent/projects/[projectId]/dependencies/route";
import { POST as newTaskInProject } from "@/app/api/agent/projects/[projectId]/tasks/route";
import { POST as newSubtask } from "@/app/api/agent/tasks/[taskId]/subtasks/route";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

function get(url: string, token?: string) {
  return new Request(`http://test${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function send(method: string, body: unknown, token?: string) {
  return new Request("http://test/api/agent", {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

const ctx = <T extends object>(params: T) => ({ params: Promise.resolve(params) });

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const teacher = await makeUser("teacher@example.com");
  await joinTeam(teacher.id, team.inviteCode);
  await updateMemberRole(owner.id, team.id, teacher.id, "teacher");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  const { token } = await createApiToken(owner.id, "CC 令牌");
  const { token: teacherToken } = await createApiToken(teacher.id, "教师令牌");
  return { owner, team, student, teacher, project, token, teacherToken };
}

async function strangerToken() {
  const s = await makeUser("stranger@example.com");
  const { token } = await createApiToken(s.id, "外人令牌");
  return token;
}

describe("PATCH /api/agent/tasks/:taskId", () => {
  beforeEach(resetDb);

  it("改任务详情：描述/起始日/状态", async () => {
    const { owner, project, token } = await scene();
    const t = await createTask(owner.id, project.id, { title: "甲" });

    const res = await patchTask(
      send(
        "PATCH",
        { description: "新描述", startDate: "2026-10-01", status: "doing" },
        token,
      ),
      ctx({ taskId: t.id }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: t.id,
      description: "新描述",
      startDate: "2026-10-01",
      status: "doing",
    });
    expect(typeof body.updatedAt).toBe("string");

    const [row] = await listProjectTasks(owner.id, project.id);
    expect(row).toMatchObject({ description: "新描述", startDate: "2026-10-01", status: "doing" });
  });

  it("null 清空日期与文本；空串视为没给（不会 500）", async () => {
    const { owner, project, token } = await scene();
    const t = await createTask(owner.id, project.id, {
      title: "甲",
      description: "旧",
      startDate: "2026-10-01",
    });

    const cleared = await patchTask(
      send("PATCH", { description: null, startDate: null }, token),
      ctx({ taskId: t.id }),
    );
    expect(cleared.status).toBe(200);
    expect((await listProjectTasks(owner.id, project.id))[0]).toMatchObject({
      description: null,
      startDate: null,
    });

    // 只给空串 = 什么也没改：不是 500，也不是「清空」，而是「没有待改字段」
    const blank = await patchTask(send("PATCH", { startDate: "" }, token), ctx({ taskId: t.id }));
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toBe("至少提供一个待改字段");
  });

  it("空 body / 白名单外字段 → 400", async () => {
    const { owner, project, token } = await scene();
    const t = await createTask(owner.id, project.id, { title: "甲" });

    const empty = await patchTask(send("PATCH", {}, token), ctx({ taskId: t.id }));
    expect(empty.status).toBe(400);

    const forged = await patchTask(
      send("PATCH", { projectId: project.id, parentTaskId: t.id }, token),
      ctx({ taskId: t.id }),
    );
    expect(forged.status).toBe(400);
    expect((await getTaskDetail(owner.id, t.id)).projectId).toBe(project.id);
  });

  it("teacher 只读 → 403；外人 → 403；无 token → 401", async () => {
    const { owner, project, teacherToken, token } = await scene();
    const t = await createTask(owner.id, project.id, { title: "甲" });

    expect((await patchTask(send("PATCH", { title: "改" }, teacherToken), ctx({ taskId: t.id })))
      .status).toBe(403);
    expect(
      (await patchTask(send("PATCH", { title: "改" }, await strangerToken()), ctx({ taskId: t.id })))
        .status,
    ).toBe(403);
    expect((await patchTask(send("PATCH", { title: "改" }), ctx({ taskId: t.id }))).status).toBe(401);
    expect((await listProjectTasks(owner.id, project.id))[0].title).toBe("甲");
    // token 参数只是为了场景完整；owner 自己当然能改
    expect((await patchTask(send("PATCH", { title: "改" }, token), ctx({ taskId: t.id }))).status).toBe(
      200,
    );
  });

  it("taskId 非 uuid → 400", async () => {
    const { token } = await scene();
    const res = await patchTask(
      send("PATCH", { title: "x" }, token),
      ctx({ taskId: "not-a-uuid" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/agent/tasks/:taskId/successors", () => {
  beforeEach(resetDb);

  it("增量新增与移除，未提到的旧边保留", async () => {
    const { owner, project, token } = await scene();
    const a = await createTask(owner.id, project.id, { title: "甲" });
    const b = await createTask(owner.id, project.id, { title: "乙" });
    const c = await createTask(owner.id, project.id, { title: "丙" });

    const first = await patchSuccessors(
      send("POST", { add: [b.id] }, token),
      ctx({ taskId: a.id }),
    );
    expect(first.status).toBe(200);
    expect((await first.json()).added).toEqual([b.id]);

    const second = await patchSuccessors(
      send("POST", { add: [c.id], remove: [b.id] }, token),
      ctx({ taskId: a.id }),
    );
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.added).toEqual([c.id]);
    expect(body.removed).toEqual([b.id]);
    expect(body.successors.map((s: { id: string }) => s.id)).toEqual([c.id]);
  });

  it("add 与 remove 相交时 remove 优先", async () => {
    const { owner, project, token } = await scene();
    const a = await createTask(owner.id, project.id, { title: "甲" });
    const b = await createTask(owner.id, project.id, { title: "乙" });
    await patchSuccessors(send("POST", { add: [b.id] }, token), ctx({ taskId: a.id }));

    const res = await patchSuccessors(
      send("POST", { add: [b.id], remove: [b.id] }, token),
      ctx({ taskId: a.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).successors).toEqual([]);
  });

  it("空操作 / 自环 / 跨项目 / 不存在 → 400", async () => {
    const { owner, team, project, token } = await scene();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const a = await createTask(owner.id, project.id, { title: "甲" });
    const x = await createTask(owner.id, other.id, { title: "外部" });

    const blank = await patchSuccessors(send("POST", {}, token), ctx({ taskId: a.id }));
    expect(blank.status).toBe(400);
    expect((await blank.json()).error).toBe("没有要调整的后置任务");

    expect((await patchSuccessors(send("POST", { add: [a.id] }, token), ctx({ taskId: a.id })))
      .status).toBe(400);
    expect((await patchSuccessors(send("POST", { add: [x.id] }, token), ctx({ taskId: a.id })))
      .status).toBe(400);
    expect(
      (await patchSuccessors(
        send("POST", { add: [a.id] }, token),
        ctx({ taskId: "00000000-0000-4000-8000-000000000000" }),
      )).status,
    ).toBe(400);
  });

  it("teacher 只读 → 403", async () => {
    const { owner, project, teacherToken } = await scene();
    const a = await createTask(owner.id, project.id, { title: "甲" });
    const b = await createTask(owner.id, project.id, { title: "乙" });
    const res = await patchSuccessors(
      send("POST", { add: [b.id] }, teacherToken),
      ctx({ taskId: a.id }),
    );
    expect(res.status).toBe(403);
  });
});

describe("GET /api/agent/projects/:projectId/dependencies", () => {
  beforeEach(resetDb);

  it("返回带标题与 crossLevel 的边", async () => {
    const { owner, project, token } = await scene();
    const a = await createTask(owner.id, project.id, { title: "甲" });
    const b = await createTask(owner.id, project.id, { title: "乙" });
    await patchSuccessors(send("POST", { add: [b.id] }, token), ctx({ taskId: a.id }));

    const res = await listDependencies(
      get(`/api/agent/projects/${project.id}/dependencies`, token),
      ctx({ projectId: project.id }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dependencies).toEqual([
      expect.objectContaining({
        predecessorTitle: "甲",
        successorTitle: "乙",
        crossLevel: false,
      }),
    ]);
  });

  it("外人 → 403；projectId 非 uuid → 400", async () => {
    const { project, token } = await scene();
    expect(
      (await listDependencies(
        get(`/api/agent/projects/${project.id}/dependencies`, await strangerToken()),
        ctx({ projectId: project.id }),
      )).status,
    ).toBe(403);
    expect(
      (await listDependencies(
        get("/api/agent/projects/nope/dependencies", token),
        ctx({ projectId: "nope" }),
      )).status,
    ).toBe(400);
  });
});

describe("GET /api/agent/tasks/:taskId 追加依赖两端", () => {
  beforeEach(resetDb);

  it("详情里出现 predecessors / successors", async () => {
    const { owner, project, token } = await scene();
    const a = await createTask(owner.id, project.id, { title: "甲" });
    const b = await createTask(owner.id, project.id, { title: "乙" });
    await patchSuccessors(send("POST", { add: [b.id] }, token), ctx({ taskId: a.id }));

    const res = await taskDetail(get(`/api/agent/tasks/${b.id}`, token), ctx({ taskId: b.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.predecessors).toEqual([
      { id: a.id, title: "甲", status: "todo", parentTaskId: null },
    ]);
    expect(body.successors).toEqual([]);
  });
});

describe("建任务端点的空串日期（原会直通 date 列 → 500）", () => {
  beforeEach(resetDb);

  it("POST /projects/:id/tasks：空串 = 未给", async () => {
    const { owner, project, token } = await scene();
    const res = await newTaskInProject(
      send("POST", { title: "甲", startDate: "", dueDate: "" }, token),
      ctx({ projectId: project.id }),
    );
    expect(res.status).toBe(200);
    expect((await listProjectTasks(owner.id, project.id))[0]).toMatchObject({
      startDate: null,
      dueDate: null,
    });
  });

  it("POST /tasks/:id/subtasks：空串 = 未给", async () => {
    const { owner, project, token } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父" });
    const res = await newSubtask(
      send("POST", { title: "子", startDate: "" }, token),
      ctx({ taskId: parent.id }),
    );
    expect(res.status).toBe(200);
    const sub = (await listProjectTasks(owner.id, project.id)).find((t) => t.title === "子");
    expect(sub?.startDate).toBeNull();
  });

  it("非法日期格式 → 400", async () => {
    const { project, token } = await scene();
    const res = await newTaskInProject(
      send("POST", { title: "甲", startDate: "2026/10/01" }, token),
      ctx({ projectId: project.id }),
    );
    expect(res.status).toBe(400);
  });
});
