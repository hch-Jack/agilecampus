import { describe, it, expect, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { taskActivities, tasks } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, listProjectTasks } from "@/lib/task";
import {
  createPropertyDef,
  updatePropertyDef,
  deletePropertyDef,
  reorderPropertyDefs,
  listPropertyDefs,
  setTaskProperties,
} from "@/lib/properties";
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

const TEXT_OPTS = [
  { name: "紧急", color: "red" as const },
  { name: "普通", color: "slate" as const },
];

async function makeSelectDef(ownerId: string, projectId: string, name = "优先级标签") {
  return createPropertyDef(ownerId, projectId, { name, type: "select", options: TEXT_OPTS });
}

describe("createPropertyDef", () => {
  beforeEach(resetDb);

  it("admin 可建文本属性，追加到末尾", async () => {
    const { owner, project } = await scene();
    const a = await createPropertyDef(owner.id, project.id, { name: "备注", type: "text" });
    const b = await createPropertyDef(owner.id, project.id, { name: "工时", type: "number" });
    expect(a.position).toBeLessThan(b.position);
    expect(a.options).toBeNull();
  });

  it("student 可建属性（任务写角色口径）", async () => {
    const { student, project } = await scene();
    const def = await createPropertyDef(student.id, project.id, { name: "实验组", type: "text" });
    expect(def.name).toBe("实验组");
  });

  it("teacher 只读，建属性被拒；非成员被拒", async () => {
    const { teacher, outsider, project } = await scene();
    await expect(createPropertyDef(teacher.id, project.id, { name: "X", type: "text" })).rejects.toThrow(
      "没有权限",
    );
    await expect(createPropertyDef(outsider.id, project.id, { name: "X", type: "text" })).rejects.toThrow(
      "没有权限",
    );
  });

  it("teacher 可读属性定义（读只需成员）", async () => {
    const { owner, teacher, project } = await scene();
    await makeSelectDef(owner.id, project.id);
    const defs = await listPropertyDefs(teacher.id, project.id);
    expect(defs).toHaveLength(1);
    expect(defs[0].options).toHaveLength(2);
  });

  it("空名与超长名被拒；名称 trim", async () => {
    const { owner, project } = await scene();
    await expect(createPropertyDef(owner.id, project.id, { name: "   ", type: "text" })).rejects.toThrow(
      "不可为空",
    );
    await expect(
      createPropertyDef(owner.id, project.id, { name: "字".repeat(31), type: "text" }),
    ).rejects.toThrow("超过");
    const def = await createPropertyDef(owner.id, project.id, { name: "  工期  ", type: "date" });
    expect(def.name).toBe("工期");
  });

  it("项目内重名被拒（大小写不敏感）；不同项目同名不冲突", async () => {
    const { owner, team, project } = await scene();
    await createPropertyDef(owner.id, project.id, { name: "Status", type: "text" });
    await expect(createPropertyDef(owner.id, project.id, { name: "status", type: "text" })).rejects.toThrow(
      "同名属性已存在",
    );
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const def = await createPropertyDef(owner.id, other.id, { name: "Status", type: "text" });
    expect(def.name).toBe("Status");
  });

  it("select 需要选项：缺失被拒、重名被拒、颜色非法被拒；合法时生成稳定 id", async () => {
    const { owner, project } = await scene();
    await expect(createPropertyDef(owner.id, project.id, { name: "S", type: "select" })).rejects.toThrow(
      "至少需要一个选项",
    );
    await expect(
      createPropertyDef(owner.id, project.id, {
        name: "S",
        type: "select",
        options: [
          { name: "同", color: "red" },
          { name: "同", color: "blue" },
        ],
      }),
    ).rejects.toThrow("选项名重复");
    await expect(
      createPropertyDef(owner.id, project.id, { name: "S", type: "select", options: [{ name: "X", color: "#ff0000" }] }),
    ).rejects.toThrow("颜色无效");
    const def = await makeSelectDef(owner.id, project.id);
    expect(def.options?.every((o) => o.id && o.id.length > 0)).toBe(true);
  });

  it("非 select 类型带 options 被拒", async () => {
    const { owner, project } = await scene();
    await expect(
      createPropertyDef(owner.id, project.id, { name: "T", type: "text", options: TEXT_OPTS }),
    ).rejects.toThrow("不支持选项");
  });
});

describe("setTaskProperties", () => {
  beforeEach(resetDb);

  it("text 值写入并在任务列表返回；空文本=清键", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "备注", type: "text" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [def.id]: "第一版" });
    let rows = await listProjectTasks(owner.id, project.id);
    expect(rows[0].properties).toEqual({ [def.id]: "第一版" });
    await setTaskProperties(owner.id, task.id, { [def.id]: "  " });
    rows = await listProjectTasks(owner.id, project.id);
    expect(rows[0].properties).toEqual({});
  });

  it("键级合并不丢键：先写 A 再写 B，两键俱在（D5 核心）", async () => {
    const { owner, project } = await scene();
    const a = await createPropertyDef(owner.id, project.id, { name: "A", type: "text" });
    const b = await createPropertyDef(owner.id, project.id, { name: "B", type: "number" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [a.id]: "x" });
    const result = await setTaskProperties(owner.id, task.id, { [b.id]: 3.5 });
    expect(result).toEqual({ [a.id]: "x", [b.id]: 3.5 });
    const [row] = await db.select({ properties: tasks.properties }).from(tasks).where(eq(tasks.id, task.id));
    expect(row.properties).toEqual({ [a.id]: "x", [b.id]: 3.5 });
  });

  it("number 校验：非数字被拒", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "工时", type: "number" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: "abc" })).rejects.toThrow("需为数字");
  });

  it("select 非法选项被拒；合法写入；null 清键", async () => {
    const { owner, project } = await scene();
    const def = await makeSelectDef(owner.id, project.id);
    const task = await createTask(owner.id, project.id, { title: "任务" });
    const badId = "99999999-9999-9999-9999-999999999999";
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: badId })).rejects.toThrow("选项不存在");
    await setTaskProperties(owner.id, task.id, { [def.id]: def.options![0].id });
    const rows = await listProjectTasks(owner.id, project.id);
    expect(rows[0].properties?.[def.id]).toBe(def.options![0].id);
    await setTaskProperties(owner.id, task.id, { [def.id]: null });
    expect((await listProjectTasks(owner.id, project.id))[0].properties).toEqual({});
  });

  it("multi_select 去重、空数组清键、非法选项被拒", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, {
      name: "参与方",
      type: "multi_select",
      options: [
        { name: "甲", color: "blue" },
        { name: "乙", color: "green" },
      ],
    });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    const [m, n] = def.options!.map((o) => o.id);
    await setTaskProperties(owner.id, task.id, { [def.id]: [m, m, n] });
    expect((await listProjectTasks(owner.id, project.id))[0].properties?.[def.id]).toEqual([m, n]);
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: [m, "not-an-option"] })).rejects.toThrow(
      "选项不存在",
    );
    await setTaskProperties(owner.id, task.id, { [def.id]: [] });
    expect((await listProjectTasks(owner.id, project.id))[0].properties).toEqual({});
  });

  it("date 校验：非法格式与不存在之日被拒", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "复核日", type: "date" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: "2026-13-01" })).rejects.toThrow("日期格式");
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: "2026-02-30" })).rejects.toThrow("日期格式");
    await setTaskProperties(owner.id, task.id, { [def.id]: "2026-11-21" });
    expect((await listProjectTasks(owner.id, project.id))[0].properties?.[def.id]).toBe("2026-11-21");
  });

  it("person：非团队成员被拒，成员可写", async () => {
    const { owner, student, outsider, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "协作人", type: "person" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: outsider.id })).rejects.toThrow(
      "不是团队成员",
    );
    await setTaskProperties(owner.id, task.id, { [def.id]: student.id });
    expect((await listProjectTasks(owner.id, project.id))[0].properties?.[def.id]).toBe(student.id);
  });

  it("checkbox：true 写入，false 清键", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "已复核", type: "checkbox" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [def.id]: false });
    expect((await listProjectTasks(owner.id, project.id))[0].properties).toEqual({});
    await setTaskProperties(owner.id, task.id, { [def.id]: true });
    expect((await listProjectTasks(owner.id, project.id))[0].properties?.[def.id]).toBe(true);
  });

  it("未定义的属性键被拒；teacher 写值被拒", async () => {
    const { owner, teacher, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "任务" });
    const ghost = "88888888-8888-8888-8888-888888888888";
    await expect(setTaskProperties(owner.id, task.id, { [ghost]: "x" })).rejects.toThrow("属性不存在");
    const def = await createPropertyDef(owner.id, project.id, { name: "备注", type: "text" });
    await expect(setTaskProperties(teacher.id, task.id, { [def.id]: "改不动" })).rejects.toThrow("没有权限");
  });

  it("属性变更入任务动态流（field=属性名，旧值→新值）", async () => {
    const { owner, project } = await scene();
    const def = await makeSelectDef(owner.id, project.id);
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [def.id]: def.options![0].id });
    await setTaskProperties(owner.id, task.id, { [def.id]: def.options![1].id });
    const acts = await db
      .select()
      .from(taskActivities)
      .where(and(eq(taskActivities.taskId, task.id), eq(taskActivities.type, "field")));
    expect(acts).toHaveLength(2);
    const pairs = acts.map((a) => [a.oldValue, a.newValue]);
    expect(pairs).toContainEqual(["无", "紧急"]);
    expect(pairs).toContainEqual(["紧急", "普通"]);
    expect(acts.every((a) => a.field === "优先级标签")).toBe(true);
  });

  it("person 变更动态流记录人名而非 userId", async () => {
    const { owner, student, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "协作人", type: "person" });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [def.id]: student.id });
    const acts = await db
      .select()
      .from(taskActivities)
      .where(and(eq(taskActivities.taskId, task.id), eq(taskActivities.type, "field")));
    expect(acts[0].oldValue).toBe("无");
    expect(acts[0].newValue).toBe("student");
  });
});

describe("updatePropertyDef", () => {
  beforeEach(resetDb);

  it("select 改名换色、追加选项，旧选项 id 稳定保留", async () => {
    const { owner, project } = await scene();
    const def = await makeSelectDef(owner.id, project.id);
    const updated = await updatePropertyDef(owner.id, project.id, def.id, {
      name: "紧急度",
      options: [
        { id: def.options![0].id, name: "紧急", color: "red" },
        { id: def.options![1].id, name: "普通", color: "amber" },
        { name: "低", color: "slate" },
      ],
    });
    expect(updated.name).toBe("紧急度");
    expect(updated.options).toHaveLength(3);
    expect(updated.options![0].id).toBe(def.options![0].id);
    expect(updated.options![1].color).toBe("amber");
    expect(updated.options![2].id).toBeTruthy();
  });

  it("删选项后任务上的该值被剥离（select 命中清键）", async () => {
    const { owner, project } = await scene();
    const def = await makeSelectDef(owner.id, project.id);
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [def.id]: def.options![0].id });
    await updatePropertyDef(owner.id, project.id, def.id, {
      options: [{ id: def.options![1].id, name: "普通", color: "slate" }],
    });
    expect((await listProjectTasks(owner.id, project.id))[0].properties).toEqual({});
  });

  it("multi_select 删选项后任务值过滤，全被删则清键", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, {
      name: "参与方",
      type: "multi_select",
      options: [
        { name: "甲", color: "blue" },
        { name: "乙", color: "green" },
        { name: "丙", color: "pink" },
      ],
    });
    const task = await createTask(owner.id, project.id, { title: "任务" });
    const [m, n, k] = def.options!.map((o) => o.id);
    await setTaskProperties(owner.id, task.id, { [def.id]: [m, n] });
    await updatePropertyDef(owner.id, project.id, def.id, {
      options: [
        { id: m, name: "甲", color: "blue" },
        { id: k, name: "丙", color: "pink" },
      ],
    });
    expect((await listProjectTasks(owner.id, project.id))[0].properties?.[def.id]).toEqual([m]);
    await updatePropertyDef(owner.id, project.id, def.id, { options: [{ id: k, name: "丙", color: "pink" }] });
    expect((await listProjectTasks(owner.id, project.id))[0].properties).toEqual({});
  });

  it("文本属性改 options 被拒；改名成功", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "备注", type: "text" });
    await expect(updatePropertyDef(owner.id, project.id, def.id, { options: TEXT_OPTS })).rejects.toThrow(
      "不支持选项",
    );
    const updated = await updatePropertyDef(owner.id, project.id, def.id, { name: "说明" });
    expect(updated.name).toBe("说明");
  });
});

describe("deletePropertyDef", () => {
  beforeEach(resetDb);

  it("删除定义并剥离任务上的键；再写报属性不存在", async () => {
    const { owner, project } = await scene();
    const def = await makeSelectDef(owner.id, project.id);
    const task = await createTask(owner.id, project.id, { title: "任务" });
    await setTaskProperties(owner.id, task.id, { [def.id]: def.options![0].id });
    await deletePropertyDef(owner.id, project.id, def.id);
    expect(await listPropertyDefs(owner.id, project.id)).toHaveLength(0);
    expect((await listProjectTasks(owner.id, project.id))[0].properties).toEqual({});
    await expect(setTaskProperties(owner.id, task.id, { [def.id]: def.options![0].id })).rejects.toThrow(
      "属性不存在",
    );
  });
});

describe("reorderPropertyDefs", () => {
  beforeEach(resetDb);

  it("顺序生效（position 0..n）", async () => {
    const { owner, project } = await scene();
    const a = await createPropertyDef(owner.id, project.id, { name: "A", type: "text" });
    const b = await createPropertyDef(owner.id, project.id, { name: "B", type: "text" });
    const c = await createPropertyDef(owner.id, project.id, { name: "C", type: "text" });
    await reorderPropertyDefs(owner.id, project.id, [c.id, a.id, b.id]);
    const defs = await listPropertyDefs(owner.id, project.id);
    expect(defs.map((d) => d.id)).toEqual([c.id, a.id, b.id]);
    expect(defs.map((d) => d.position)).toEqual([0, 1, 2]);
  });

  it("列表不完整或有重复被拒", async () => {
    const { owner, project } = await scene();
    const a = await createPropertyDef(owner.id, project.id, { name: "A", type: "text" });
    const b = await createPropertyDef(owner.id, project.id, { name: "B", type: "text" });
    await expect(reorderPropertyDefs(owner.id, project.id, [a.id])).rejects.toThrow("不完整");
    await expect(reorderPropertyDefs(owner.id, project.id, [a.id, a.id])).rejects.toThrow("不完整");
    void b;
  });
});

describe("createTask 带初始属性", () => {
  beforeEach(resetDb);

  it("合法值随任务落库；非法值整个报错且任务不创建", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "备注", type: "text" });
    await createTask(owner.id, project.id, { title: "任务", properties: { [def.id]: "初始" } });
    expect((await listProjectTasks(owner.id, project.id))[0].properties?.[def.id]).toBe("初始");
    await expect(
      createTask(owner.id, project.id, { title: "坏任务", properties: { [def.id]: 123 } }),
    ).rejects.toThrow("需为文本");
    expect(await listProjectTasks(owner.id, project.id)).toHaveLength(1);
  });
});
