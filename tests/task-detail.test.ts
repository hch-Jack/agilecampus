import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import {
  createSubtask,
  createTask,
  updateTask,
  setTaskSuccessors,
  listProjectDependencies,
} from "@/lib/task";
import { db } from "@/db";
import { taskDependencies } from "@/db/schema";
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

describe("completionNote", () => {
  beforeEach(resetDb);
  it("可写入完成情况", async () => {
    const { student, project } = await scene();
    const t = await createTask(student.id, project.id, { title: "甲" });
    // completionNote 独立于状态可写；status=done 会被学生审批流拦截（approval.test.ts 专测）
    const u = await updateTask(student.id, t.id, {
      completionNote: "已按计划完成，附实验数据",
    });
    expect(u.status).toBe("todo");
    expect(u.completionNote).toBe("已按计划完成，附实验数据");
  });
});

describe("后置任务关联", () => {
  beforeEach(resetDb);
  it("设置并列出后置任务", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    const c = await createTask(student.id, project.id, { title: "丙" });
    await setTaskSuccessors(student.id, a.id, [b.id, c.id]);
    const deps = await listProjectDependencies(student.id, project.id);
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.successorId).sort()).toEqual([b.id, c.id].sort());
    expect(deps.every((d) => d.predecessorId === a.id)).toBe(true);
  });

  it("重设覆盖旧关联", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    const c = await createTask(student.id, project.id, { title: "丙" });
    await setTaskSuccessors(student.id, a.id, [b.id]);
    await setTaskSuccessors(student.id, a.id, [c.id]);
    const deps = await listProjectDependencies(student.id, project.id);
    expect(deps).toHaveLength(1);
    expect(deps[0].successorId).toBe(c.id);
  });

  it("防直接循环：后置不可指向自身或已是其前置者", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    await expect(setTaskSuccessors(student.id, a.id, [a.id])).rejects.toThrow("循环");
    await setTaskSuccessors(student.id, b.id, [a.id]);
    await expect(setTaskSuccessors(student.id, a.id, [b.id])).rejects.toThrow("循环");
  });

  it("后置任务须属同项目", async () => {
    const { owner, team, student, project } = await scene();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const a = await createTask(student.id, project.id, { title: "甲" });
    const x = await createTask(owner.id, other.id, { title: "外部" });
    await expect(setTaskSuccessors(student.id, a.id, [x.id])).rejects.toThrow("不属于该项目");
  });

  it("非成员被拒", async () => {
    const { outsider, student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    await expect(setTaskSuccessors(outsider.id, a.id, [])).rejects.toThrow("没有权限");
  });

  it("同一父任务下的兄弟可互设后置", async () => {
    const { student, project } = await scene();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const c1 = await createSubtask(student.id, parent.id, { title: "子1" });
    const c2 = await createSubtask(student.id, parent.id, { title: "子2" });

    await setTaskSuccessors(student.id, c1.id, [c2.id]);
    const deps = await listProjectDependencies(student.id, project.id);
    expect(deps).toEqual([{ predecessorId: c1.id, successorId: c2.id }]);
  });

  it("父→子、子→父、跨父同深度都被同级规则拒绝", async () => {
    const { student, project } = await scene();
    const p1 = await createTask(student.id, project.id, { title: "父1" });
    const p2 = await createTask(student.id, project.id, { title: "父2" });
    const c1 = await createSubtask(student.id, p1.id, { title: "子1" });
    const c3 = await createSubtask(student.id, p2.id, { title: "子3" });

    await expect(setTaskSuccessors(student.id, p1.id, [c1.id])).rejects.toThrow("同级");
    await expect(setTaskSuccessors(student.id, c1.id, [p1.id])).rejects.toThrow("同级");
    await expect(setTaskSuccessors(student.id, c1.id, [c3.id])).rejects.toThrow("同级");
  });

  it("重复的后置 id 去重后只落一条边", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });

    await setTaskSuccessors(student.id, a.id, [b.id, b.id]);
    const deps = await listProjectDependencies(student.id, project.id);
    expect(deps).toHaveLength(1);
    expect(deps[0].successorId).toBe(b.id);
  });

  it("拒绝间接环 a→b→c→a", async () => {
    const { student, project } = await scene();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const a = await createSubtask(student.id, parent.id, { title: "子A" });
    const b = await createSubtask(student.id, parent.id, { title: "子B" });
    const c = await createSubtask(student.id, parent.id, { title: "子C" });

    await setTaskSuccessors(student.id, a.id, [b.id]);
    await setTaskSuccessors(student.id, b.id, [c.id]);
    await expect(setTaskSuccessors(student.id, c.id, [a.id])).rejects.toThrow("循环");
  });

  it("历史跨层级边可读；改同级集合时才被移除", async () => {
    const { student, project } = await scene();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const c1 = await createSubtask(student.id, parent.id, { title: "子1" });
    const c2 = await createSubtask(student.id, parent.id, { title: "子2" });
    const top = await createTask(student.id, project.id, { title: "顶层" });

    // 模拟规则上线前的历史数据：子任务 → 顶层任务
    await db
      .insert(taskDependencies)
      .values({ predecessorId: c1.id, successorId: top.id });

    expect(await listProjectDependencies(student.id, project.id)).toHaveLength(1);

    // 同级集合变化后走全量替换，历史边移除
    await setTaskSuccessors(student.id, c1.id, [c2.id]);
    const deps = await listProjectDependencies(student.id, project.id);
    expect(deps).toEqual([{ predecessorId: c1.id, successorId: c2.id }]);
  });

  it("同级集合未变时可保留历史跨层级边（preserve 选项）", async () => {
    const { student, project } = await scene();
    const parent = await createTask(student.id, project.id, { title: "父" });
    const c1 = await createSubtask(student.id, parent.id, { title: "子1" });
    const c2 = await createSubtask(student.id, parent.id, { title: "子2" });
    const top = await createTask(student.id, project.id, { title: "顶层" });

    await db
      .insert(taskDependencies)
      .values({ predecessorId: c1.id, successorId: top.id });

    // 提交的同级集合（空）与库中一致 → 不动任何边
    await setTaskSuccessors(student.id, c1.id, [], {
      preserveCrossLevelIfSiblingSetUnchanged: true,
    });
    expect(await listProjectDependencies(student.id, project.id)).toEqual([
      { predecessorId: c1.id, successorId: top.id },
    ]);

    // 同级集合变化 → 全量替换，历史边移除
    await setTaskSuccessors(student.id, c1.id, [c2.id], {
      preserveCrossLevelIfSiblingSetUnchanged: true,
    });
    expect(await listProjectDependencies(student.id, project.id)).toEqual([
      { predecessorId: c1.id, successorId: c2.id },
    ]);
  });
});
