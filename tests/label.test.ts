import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, listProjectTasks } from "@/lib/task";
import {
  createLabel,
  getLabelDetail,
  listTeamLabels,
  listTeamLabelsWithUsage,
  renameLabel,
  deleteLabel,
  setTaskLabels,
} from "@/lib/label";
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
  return { owner, team, student, teacher, outsider };
}

describe("createLabel", () => {
  beforeEach(resetDb);

  it("admin 可建标签，默认色 slate", async () => {
    const { owner, team } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    expect(label.name).toBe("论文");
    expect(label.color).toBe("slate");
  });

  it("student 建标签被拒", async () => {
    const { student, team } = await scene();
    await expect(createLabel(student.id, team.id, { name: "实验" })).rejects.toThrow("没有权限");
  });

  it("非成员建标签被拒", async () => {
    const { outsider, team } = await scene();
    await expect(createLabel(outsider.id, team.id, { name: "实验" })).rejects.toThrow("没有权限");
  });

  it("同团队重名（大小写不同）被拒", async () => {
    const { owner, team } = await scene();
    await createLabel(owner.id, team.id, { name: "Paper" });
    await expect(createLabel(owner.id, team.id, { name: "paper" })).rejects.toThrow("标签已存在");
  });

  it("空名与超长名被拒", async () => {
    const { owner, team } = await scene();
    await expect(createLabel(owner.id, team.id, { name: "   " })).rejects.toThrow("不可为空");
    await expect(createLabel(owner.id, team.id, { name: "字".repeat(21) })).rejects.toThrow("超过");
  });

  it("名称写入前 trim", async () => {
    const { owner, team } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "  数据清洗  " });
    expect(label.name).toBe("数据清洗");
  });
});

describe("listTeamLabels", () => {
  beforeEach(resetDb);

  it("团队成员（含 teacher）可读，按名称排序", async () => {
    const { owner, team, teacher } = await scene();
    await createLabel(owner.id, team.id, { name: "实验", color: "green" });
    await createLabel(owner.id, team.id, { name: "代码", color: "blue" });
    const list = await listTeamLabels(teacher.id, team.id);
    expect(list.map((l) => l.name)).toEqual(["代码", "实验"]);
  });

  it("非成员读取被拒", async () => {
    const { outsider, team } = await scene();
    await expect(listTeamLabels(outsider.id, team.id)).rejects.toThrow("没有权限");
  });
});

describe("listTeamLabelsWithUsage", () => {
  beforeEach(resetDb);

  it("带团队名与每标签的任务数（没贴任务的标签为 0）", async () => {
    const { owner, team, student, teacher } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const t1 = await createTask(student.id, project.id, { title: "甲" });
    const t2 = await createTask(student.id, project.id, { title: "乙" });
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    const code = await createLabel(owner.id, team.id, { name: "代码" });
    await setTaskLabels(student.id, t1.id, [paper.id]);
    await setTaskLabels(student.id, t2.id, [paper.id]);

    const out = await listTeamLabelsWithUsage(teacher.id, team.id);
    expect(out.teamId).toBe(team.id);
    expect(out.teamName).toBe("东吴实验室");
    expect(out.role).toBe("teacher");
    expect(out.labels).toEqual([
      { id: code.id, name: "代码", color: "slate", usageCount: 0 },
      { id: paper.id, name: "论文", color: "slate", usageCount: 2 },
    ]);
  });

  it("非成员被拒，团队不存在则报不存在", async () => {
    const { outsider, student, team } = await scene();
    await expect(listTeamLabelsWithUsage(outsider.id, team.id)).rejects.toThrow("没有权限");
    await expect(
      listTeamLabelsWithUsage(student.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("团队不存在");
  });
});

describe("getLabelDetail", () => {
  beforeEach(resetDb);

  it("成员可读，带团队名 / 使用数 / canManage（仅 admin）", async () => {
    const { owner, team, student } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const task = await createTask(student.id, project.id, { title: "甲" });
    const label = await createLabel(owner.id, team.id, { name: "论文", color: "red" });
    await setTaskLabels(student.id, task.id, [label.id]);

    const asOwner = await getLabelDetail(owner.id, label.id);
    expect(asOwner).toMatchObject({
      id: label.id,
      teamId: team.id,
      teamName: "东吴实验室",
      name: "论文",
      color: "red",
      usageCount: 1,
      canManage: true,
    });
    expect((await getLabelDetail(student.id, label.id)).canManage).toBe(false);
  });

  it("非成员读被拒，不存在的 id 报不存在", async () => {
    const { owner, outsider, team } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    await expect(getLabelDetail(outsider.id, label.id)).rejects.toThrow("没有权限");
    await expect(
      getLabelDetail(owner.id, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow("标签不存在");
  });
});

describe("renameLabel", () => {
  beforeEach(resetDb);

  it("admin 可改名换色", async () => {
    const { owner, team } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    const updated = await renameLabel(owner.id, label.id, { name: "论文写作", color: "violet" });
    expect(updated.name).toBe("论文写作");
    expect(updated.color).toBe("violet");
  });

  it("改名撞上同团队既有标签被拒", async () => {
    const { owner, team } = await scene();
    await createLabel(owner.id, team.id, { name: "论文" });
    const other = await createLabel(owner.id, team.id, { name: "实验" });
    await expect(renameLabel(owner.id, other.id, { name: "论文" })).rejects.toThrow("标签已存在");
  });

  it("改成自身原名不算重名", async () => {
    const { owner, team } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    const updated = await renameLabel(owner.id, label.id, { name: "论文", color: "red" });
    expect(updated.color).toBe("red");
  });

  it("student 改标签被拒", async () => {
    const { owner, team, student } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    await expect(renameLabel(student.id, label.id, { name: "改名" })).rejects.toThrow("没有权限");
  });
});

describe("deleteLabel", () => {
  beforeEach(resetDb);

  it("admin 可删标签", async () => {
    const { owner, team } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    await deleteLabel(owner.id, label.id);
    expect(await listTeamLabels(owner.id, team.id)).toEqual([]);
  });

  it("student 删标签被拒", async () => {
    const { owner, team, student } = await scene();
    const label = await createLabel(owner.id, team.id, { name: "论文" });
    await expect(deleteLabel(student.id, label.id)).rejects.toThrow("没有权限");
  });

  it("标签不存在则报错", async () => {
    const { owner } = await scene();
    await expect(
      deleteLabel(owner.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("标签不存在");
  });
});

describe("setTaskLabels", () => {
  beforeEach(resetDb);

  it("student 可贴标签，全量替换", async () => {
    const { owner, team, student } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const task = await createTask(student.id, project.id, { title: "撰写问卷" });
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    const code = await createLabel(owner.id, team.id, { name: "代码" });

    await setTaskLabels(student.id, task.id, [paper.id, code.id]);
    await setTaskLabels(student.id, task.id, [code.id]);

    const [row] = await listProjectTasks(student.id, project.id);
    expect(row.labels.map((l) => l.name)).toEqual(["代码"]);
  });

  it("重复 labelId 去重后不报错", async () => {
    const { owner, team, student } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const task = await createTask(student.id, project.id, { title: "撰写问卷" });
    const paper = await createLabel(owner.id, team.id, { name: "论文" });

    await setTaskLabels(student.id, task.id, [paper.id, paper.id]);
    const [row] = await listProjectTasks(student.id, project.id);
    expect(row.labels).toHaveLength(1);
  });

  it("teacher 贴标签被拒（只读角色）", async () => {
    const { owner, team, teacher, student } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const task = await createTask(student.id, project.id, { title: "撰写问卷" });
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    await expect(setTaskLabels(teacher.id, task.id, [paper.id])).rejects.toThrow("没有权限");
  });

  it("跨团队标签挂载被拒", async () => {
    const { owner, team, student } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const task = await createTask(student.id, project.id, { title: "撰写问卷" });

    const other = await makeUser("other-admin@example.com");
    const otherTeam = await createTeam(other.id, "西蜀实验室");
    const alien = await createLabel(other.id, otherTeam.id, { name: "外营标签" });

    await expect(setTaskLabels(student.id, task.id, [alien.id])).rejects.toThrow(
      "标签不属于该团队",
    );
  });

  it("任务不存在则报错", async () => {
    const { student } = await scene();
    await expect(
      setTaskLabels(student.id, "00000000-0000-0000-0000-000000000000", []),
    ).rejects.toThrow("任务不存在");
  });

  it("删标签后任务上的贴附随之消失", async () => {
    const { owner, team, student } = await scene();
    const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
    const task = await createTask(student.id, project.id, { title: "撰写问卷" });
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    await setTaskLabels(student.id, task.id, [paper.id]);

    await deleteLabel(owner.id, paper.id);
    const [row] = await listProjectTasks(student.id, project.id);
    expect(row.labels).toEqual([]);
  });
});
