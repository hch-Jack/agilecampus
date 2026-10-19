import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { taskDependencies } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createMilestone, createProject } from "@/lib/project";
import {
  applyTaskSuccessorDelta,
  createSubtask,
  createTask,
  getTaskDetailBundle,
  listProjectDependencies,
  listProjectDependenciesDetailed,
  listTaskLinks,
  setTaskSuccessors,
} from "@/lib/task";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
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

describe("listTaskLinks / listProjectDependenciesDetailed", () => {
  beforeEach(resetDb);

  it("单任务的前置与后置都带标题、状态、父任务", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    const c = await createTask(student.id, project.id, { title: "丙" });
    await setTaskSuccessors(student.id, a.id, [b.id]);
    await setTaskSuccessors(student.id, b.id, [c.id]);

    const mid = await listTaskLinks(student.id, b.id);
    expect(mid.predecessors).toEqual([
      { id: a.id, title: "甲", status: "todo", parentTaskId: null },
    ]);
    expect(mid.successors).toEqual([
      { id: c.id, title: "丙", status: "todo", parentTaskId: null },
    ]);
  });

  it("任务不存在 / 非成员：分别报「任务不存在」与「没有权限」", async () => {
    const { student, outsider, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    await expect(
      listTaskLinks(student.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("任务不存在");
    await expect(listTaskLinks(outsider.id, a.id)).rejects.toThrow("没有权限");
  });

  it("项目级依赖边带两端标题与 crossLevel", async () => {
    const { student, project } = await scene();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const c1 = await createSubtask(student.id, parent.id, { title: "子1" });
    const c2 = await createSubtask(student.id, parent.id, { title: "子2" });
    const top = await createTask(student.id, project.id, { title: "顶层" });
    await setTaskSuccessors(student.id, c1.id, [c2.id]);
    // 历史跨层级边（规则上线前的数据）
    await db.insert(taskDependencies).values({ predecessorId: c1.id, successorId: top.id });

    const rows = await listProjectDependenciesDetailed(student.id, project.id);
    const sibling = rows.find((r) => r.successorId === c2.id);
    const cross = rows.find((r) => r.successorId === top.id);
    expect(sibling).toMatchObject({
      predecessorTitle: "子1",
      successorTitle: "子2",
      crossLevel: false,
    });
    expect(cross).toMatchObject({ successorTitle: "顶层", crossLevel: true });

    // 旧函数形状不变（图页面与既有测试钉着）
    expect(await listProjectDependencies(student.id, project.id)).toHaveLength(2);
  });
});

describe("getTaskDetailBundle", () => {
  beforeEach(resetDb);

  it("详情 + 子任务 + 前后置 + 里程碑/父任务标题", async () => {
    const { owner, student, project } = await scene();
    const milestone = (
      await createMilestone(owner.id, project.id, { title: "中期答辩" })
    ).id;
    const parent = await createTask(student.id, project.id, { title: "父" });
    const sub = await createSubtask(student.id, parent.id, {
      title: "子",
      milestoneId: milestone,
      startDate: "2026-10-01",
      dueDate: "2026-10-20",
      description: "细节",
    });

    const d = await getTaskDetailBundle(student.id, sub.id);
    expect(d).toMatchObject({
      id: sub.id,
      title: "子",
      description: "细节",
      startDate: "2026-10-01",
      parentTitle: "父",
      milestoneTitle: "中期答辩",
    });
    expect(d.subtasks).toEqual([]);
    expect(d.predecessors).toEqual([]);
    expect(d.successors).toEqual([]);

    const p = await getTaskDetailBundle(student.id, parent.id);
    expect(p.subtasks.map((s) => s.title)).toEqual(["子"]);
  });

  it("给了 projectId 时必须对得上", async () => {
    const { owner, team, student, project } = await scene();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const t = await createTask(student.id, project.id, { title: "甲" });
    await expect(getTaskDetailBundle(student.id, t.id, { projectId: other.id })).rejects.toThrow(
      "任务不属于该项目",
    );
    await expect(getTaskDetailBundle(student.id, t.id, { projectId: project.id })).resolves.toMatchObject(
      { id: t.id },
    );
  });
});

describe("applyTaskSuccessorDelta", () => {
  beforeEach(resetDb);

  async function setup() {
    const s = await scene();
    const a = await createTask(s.student.id, s.project.id, { title: "甲" });
    const b = await createTask(s.student.id, s.project.id, { title: "乙" });
    const c = await createTask(s.student.id, s.project.id, { title: "丙" });
    return { ...s, a, b, c };
  }

  it("增量新增不影响未提到的旧后置", async () => {
    const { student, a, b, c } = await setup();
    await setTaskSuccessors(student.id, a.id, [b.id]);

    const r = await applyTaskSuccessorDelta(student.id, a.id, { add: [c.id] });
    expect(r.added).toEqual([c.id]);
    expect(r.removed).toEqual([]);
    expect(r.successors.map((s) => s.id).sort()).toEqual([b.id, c.id].sort());
  });

  it("增量移除只删指定的边", async () => {
    const { student, a, b, c } = await setup();
    await setTaskSuccessors(student.id, a.id, [b.id, c.id]);

    const r = await applyTaskSuccessorDelta(student.id, a.id, { remove: [b.id] });
    expect(r.removed).toEqual([b.id]);
    expect(r.successors.map((s) => s.id)).toEqual([c.id]);
  });

  it("add 与 remove 相交时 remove 优先", async () => {
    const { student, a, b } = await setup();
    await setTaskSuccessors(student.id, a.id, [b.id]);
    const r = await applyTaskSuccessorDelta(student.id, a.id, {
      add: [b.id],
      remove: [b.id],
    });
    expect(r.added).toEqual([]);
    expect(r.removed).toEqual([b.id]);
    expect(r.successors).toEqual([]);
  });

  it("重复 add 是幂等的，也不误删旧边", async () => {
    const { student, a, b } = await setup();
    await setTaskSuccessors(student.id, a.id, [b.id]);
    const r = await applyTaskSuccessorDelta(student.id, a.id, { add: [b.id] });
    expect(r).toEqual({ predecessorId: a.id, added: [], removed: [], successors: [
      { id: b.id, title: "乙", status: "todo", parentTaskId: null },
    ] });
  });

  it("两者都空 → 报错", async () => {
    const { student, a } = await setup();
    await expect(applyTaskSuccessorDelta(student.id, a.id, {})).rejects.toThrow(
      "没有要调整的后置任务",
    );
    await expect(applyTaskSuccessorDelta(student.id, a.id, { add: [], remove: [] })).rejects.toThrow(
      "没有要调整的后置任务",
    );
  });

  it("自环在本地先拦", async () => {
    const { student, a } = await setup();
    await expect(applyTaskSuccessorDelta(student.id, a.id, { add: [a.id] })).rejects.toThrow("循环");
  });

  it("间接环交给 setTaskSuccessors", async () => {
    const { student, a, b, c } = await setup();
    await setTaskSuccessors(student.id, a.id, [b.id]);
    await setTaskSuccessors(student.id, b.id, [c.id]);
    await expect(applyTaskSuccessorDelta(student.id, c.id, { add: [a.id] })).rejects.toThrow("循环");
  });

  it("跨项目后置被拒", async () => {
    const { owner, team, student, a } = await setup();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const x = await createTask(owner.id, other.id, { title: "外部" });
    await expect(applyTaskSuccessorDelta(student.id, a.id, { add: [x.id] })).rejects.toThrow(
      "不属于该项目",
    );
  });

  it("跨层级历史边：remove 明确报错且边还在，add 亦被同级规则拒", async () => {
    const { student, project, a, b } = await setup();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const child = await createSubtask(student.id, parent.id, { title: "子" });
    const top = await createTask(student.id, project.id, { title: "顶层" });
    await db.insert(taskDependencies).values({ predecessorId: child.id, successorId: top.id });

    await expect(
      applyTaskSuccessorDelta(student.id, child.id, { remove: [top.id] }),
    ).rejects.toThrow("跨层级后置任务不能通过此接口调整");
    // setTaskSuccessors 的 preserve 选项会让「静默无效」发生 —— 故必须先拦在 delta 这层
    expect(await listProjectDependencies(student.id, project.id)).toEqual([
      { predecessorId: child.id, successorId: top.id },
    ]);

    await expect(
      applyTaskSuccessorDelta(student.id, child.id, { add: [a.id] }),
    ).rejects.toThrow("同级");
    await expect(
      applyTaskSuccessorDelta(student.id, child.id, { add: [b.id] }),
    ).rejects.toThrow("同级");
  });

  it("同级集合没变时保留跨层级历史边", async () => {
    const { student, project } = await setup();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const c1 = await createSubtask(student.id, parent.id, { title: "子1" });
    const c2 = await createSubtask(student.id, parent.id, { title: "子2" });
    const top = await createTask(student.id, project.id, { title: "顶层" });
    await setTaskSuccessors(student.id, c1.id, [c2.id]);
    await db.insert(taskDependencies).values({ predecessorId: c1.id, successorId: top.id });

    // 重复 add 已是同级后置的 c2：实际无变化 → preserve 生效，历史边不动
    const r = await applyTaskSuccessorDelta(student.id, c1.id, { add: [c2.id] });
    expect(r.added).toEqual([]);
    expect((await listProjectDependencies(student.id, project.id)).map((d) => d.successorId).sort()).toEqual(
      [c2.id, top.id].sort(),
    );
  });

  it("权限：teacher 只读、非成员、任务不存在、项目对不上", async () => {
    const { owner, team, teacher, outsider, student, project } = await setup();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const t = await createTask(student.id, project.id, { title: "丁" });

    await expect(applyTaskSuccessorDelta(teacher.id, t.id, { add: [t.id] })).rejects.toThrow(
      "没有权限",
    );
    await expect(applyTaskSuccessorDelta(outsider.id, t.id, { add: [t.id] })).rejects.toThrow(
      "没有权限",
    );
    await expect(
      applyTaskSuccessorDelta(student.id, "00000000-0000-4000-8000-000000000000", { add: [t.id] }),
    ).rejects.toThrow("任务不存在");
    await expect(
      applyTaskSuccessorDelta(student.id, t.id, { add: [t.id] }, { projectId: other.id }),
    ).rejects.toThrow("任务不属于该项目");
  });
});
