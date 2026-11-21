import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createPropertyDef } from "@/lib/properties";
import {
  listProjectViews,
  saveView,
  renameView,
  deleteView,
  reorderViews,
  normalizeConfig,
} from "@/lib/database-views";
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

const GHOST_PROP = "77777777-7777-7777-7777-777777777777";

describe("listProjectViews", () => {
  beforeEach(resetDb);

  it("无持久视图时派生三个内置默认（id=null，config 空）", async () => {
    const { owner, project } = await scene();
    const views = await listProjectViews(owner.id, project.id);
    expect(views.map((v) => [v.kind, v.name])).toEqual([
      ["table", "表格"],
      ["board", "看板"],
      ["timeline", "时间线"],
    ]);
    expect(views.every((v) => v.id === null && Object.keys(v.config).length === 0)).toBe(true);
  });

  it("teacher 可读；非成员被拒", async () => {
    const { teacher, outsider, project } = await scene();
    expect(await listProjectViews(teacher.id, project.id)).toHaveLength(3);
    await expect(listProjectViews(outsider.id, project.id)).rejects.toThrow("没有权限");
  });

  it("已有持久视图时只补齐缺失 kind 的默认；全删后默认重新派生", async () => {
    const { owner, project } = await scene();
    const saved = await saveView(owner.id, project.id, { kind: "board", name: "按状态", config: {} });
    let views = await listProjectViews(owner.id, project.id);
    expect(views.filter((v) => v.kind === "board")).toHaveLength(1);
    expect(views.filter((v) => v.id === null).map((v) => v.kind)).toEqual(["table", "timeline"]);
    await deleteView(owner.id, project.id, saved.id!);
    views = await listProjectViews(owner.id, project.id);
    expect(views).toHaveLength(3);
  });
});

describe("saveView", () => {
  beforeEach(resetDb);

  it("新建视图落库；config 归一剔除失效引用（已删属性/未知字段），保留合法 prop 引用", async () => {
    const { owner, project } = await scene();
    const def = await createPropertyDef(owner.id, project.id, { name: "备注", type: "text" });
    const view = await saveView(owner.id, project.id, {
      kind: "table",
      name: "我的表格",
      config: {
        groupBy: "status",
        filters: [
          { id: "f1", field: `prop:${def.id}`, op: "contains", value: "x" },
          { id: "f2", field: `prop:${GHOST_PROP}`, op: "contains", value: "y" },
          { id: "f3", field: "galaxy", op: "contains", value: "z" },
        ],
        sorts: [{ field: "dueDate", dir: "asc" }],
        hiddenColumns: ["title", "label", `prop:${GHOST_PROP}`],
      },
    });
    expect(view.id).not.toBeNull();
    expect(view.config.filters).toHaveLength(1);
    expect(view.config.filters![0].field).toBe(`prop:${def.id}`);
    expect(view.config.sorts).toEqual([{ field: "dueDate", dir: "asc" }]);
    expect(view.config.hiddenColumns).toEqual(["title", "label"]);
    expect(view.config.groupBy).toBe("status");
  });

  it("groupBy 引用已删属性被剔除；原生合法分组保留", async () => {
    const { owner, project } = await scene();
    const v1 = await saveView(owner.id, project.id, { kind: "board", name: "A", config: { groupBy: "milestone" } });
    expect(v1.config.groupBy).toBe("milestone");
    const v2 = await saveView(owner.id, project.id, { kind: "board", name: "B", config: { groupBy: `prop:${GHOST_PROP}` } });
    expect(v2.config.groupBy).toBeUndefined();
  });

  it("更新已有视图：name/config 全量替换，kind 不变", async () => {
    const { owner, project } = await scene();
    const created = await saveView(owner.id, project.id, { kind: "board", name: "旧名", config: {} });
    const updated = await saveView(owner.id, project.id, {
      id: created.id!,
      kind: "timeline", // kind 入参在更新路径被忽略
      name: "新名",
      config: { filters: [{ id: "f", field: "priority", op: "in", value: ["high"] }] },
    });
    expect(updated.id).toBe(created.id);
    expect(updated.kind).toBe("board");
    expect(updated.name).toBe("新名");
    expect(updated.config.filters).toEqual([{ id: "f", field: "priority", op: "in", value: ["high"] }]);
  });

  it("视图名空/超长被拒；student 可建；teacher 写被拒", async () => {
    const { owner, student, teacher, project } = await scene();
    await expect(saveView(owner.id, project.id, { kind: "table", name: "  ", config: {} })).rejects.toThrow(
      "不可为空",
    );
    await expect(
      saveView(owner.id, project.id, { kind: "table", name: "字".repeat(31), config: {} }),
    ).rejects.toThrow("超过");
    const saved = await saveView(student.id, project.id, { kind: "table", name: "学生的视图", config: {} });
    expect(saved.name).toBe("学生的视图");
    await expect(saveView(teacher.id, project.id, { kind: "table", name: "X", config: {} })).rejects.toThrow(
      "没有权限",
    );
  });

  it("不存在的 viewId 更新被拒", async () => {
    const { owner, project } = await scene();
    await expect(
      saveView(owner.id, project.id, { id: GHOST_PROP, kind: "table", name: "X", config: {} }),
    ).rejects.toThrow("视图不存在");
  });
});

describe("renameView / deleteView / reorderViews", () => {
  beforeEach(resetDb);

  it("改名生效", async () => {
    const { owner, project } = await scene();
    const saved = await saveView(owner.id, project.id, { kind: "table", name: "旧", config: {} });
    const renamed = await renameView(owner.id, project.id, saved.id!, "新");
    expect(renamed.name).toBe("新");
  });

  it("他项目的 viewId 操作被拒", async () => {
    const { owner, team, project } = await scene();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const saved = await saveView(owner.id, project.id, { kind: "table", name: "A", config: {} });
    await expect(renameView(owner.id, other.id, saved.id!, "B")).rejects.toThrow("视图不存在");
    await expect(deleteView(owner.id, other.id, saved.id!)).rejects.toThrow("视图不存在");
  });

  it("重排持久视图顺序生效；列表不完整被拒；默认视图 id=null 不可重排", async () => {
    const { owner, project } = await scene();
    const a = await saveView(owner.id, project.id, { kind: "table", name: "A", config: {} });
    const b = await saveView(owner.id, project.id, { kind: "board", name: "B", config: {} });
    await reorderViews(owner.id, project.id, [b.id!, a.id!]);
    const views = await listProjectViews(owner.id, project.id);
    expect(views.filter((v) => v.id !== null).map((v) => v.name)).toEqual(["B", "A"]);
    await expect(reorderViews(owner.id, project.id, [a.id!])).rejects.toThrow("不完整");
    // 派生默认视图（timeline 仍为默认）不在持久集合里，传 id=null 会校验失败
    await expect(reorderViews(owner.id, project.id, [a.id!, b.id!, "not-a-uuid"])).rejects.toThrow();
  });
});

describe("normalizeConfig", () => {
  it("形状非法的子配置整体忽略", () => {
    const valid = new Set<string>();
    expect(normalizeConfig({ filters: "不是数组", sorts: [{ field: "title" }] }, valid)).toEqual({});
    expect(normalizeConfig("垃圾", valid)).toEqual({});
    expect(normalizeConfig(null, valid)).toEqual({});
  });

  it("sorts 截断到 2 级，filters 截断到 10 条", () => {
    const valid = new Set<string>();
    const sorts = [
      { field: "title", dir: "asc" },
      { field: "dueDate", dir: "desc" },
      { field: "priority", dir: "asc" },
    ];
    expect(normalizeConfig({ sorts }, valid).sorts).toHaveLength(2);
    const filters = Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, field: "title", op: "contains" }));
    expect(normalizeConfig({ filters }, valid).filters).toHaveLength(10);
  });
});
