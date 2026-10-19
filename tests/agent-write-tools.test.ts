import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks, projects, milestones, taskDependencies } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { buildTools, WRITE_TOOL_NAMES } from "@/lib/agent/tools";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, team, student, project };
}

// AI SDK 的 tool.execute 签名为 (input, options)；测试直调传占位 options
const opts = {} as never;

describe("写工具产草案不落库", () => {
  beforeEach(resetDb);

  it("WRITE_TOOL_NAMES 含项目写工具（含子任务与附件管理）", () => {
    expect(WRITE_TOOL_NAMES).toEqual([
      "create_project",
      "decompose_tasks",
      "update_tasks",
      "edit_task_links",
      "plan_sprint",
      "create_milestone",
      "create_subtask",
      "delete_subtask",
      "delete_attachment",
    ]);
  });

  it("create_milestone 产草案信封，且 milestones 表无新行", async () => {
    const { student, project } = await scene();
    const tools = buildTools(student.id, project.id);
    const out = await tools.create_milestone.execute!(
      { title: "中期答辩", targetDate: "2026-11-15" },
      opts,
    );
    expect(out).toMatchObject({
      __draft: true,
      tool: "create_milestone",
      draft: { title: "中期答辩", targetDate: "2026-11-15" },
    });
    const rows = await db.select().from(milestones).where(eq(milestones.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it("decompose_tasks 产草案信封，且 tasks 表无新行", async () => {
    const { student, project } = await scene();
    const tools = buildTools(student.id, project.id);
    const out = await tools.decompose_tasks.execute!(
      { tasks: [{ title: "撰写问卷" }, { title: "分析数据" }] },
      opts,
    );
    expect(out).toMatchObject({
      __draft: true,
      tool: "decompose_tasks",
      draft: { tasks: [{ title: "撰写问卷" }, { title: "分析数据" }] },
    });
    const rows = await db.select().from(tasks).where(eq(tasks.projectId, project.id));
    expect(rows).toHaveLength(0);
  });

  it("create_project 产草案信封，且 projects 表无新行", async () => {
    const { student, project } = await scene();
    const tools = buildTools(student.id, project.id);
    const before = await db.select().from(projects);
    const out = await tools.create_project.execute!(
      { name: "新项目", description: "描述" },
      opts,
    );
    expect(out).toMatchObject({ __draft: true, tool: "create_project", draft: { name: "新项目" } });
    const after = await db.select().from(projects);
    expect(after).toHaveLength(before.length);
  });

  it("edit_task_links 产草案并带上卡片展示数据，且依赖表无新行", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "前置" });
    const b = await createTask(student.id, project.id, { title: "后置" });
    const tools = buildTools(student.id, project.id);

    const out = await tools.edit_task_links.execute!(
      { predecessorId: a.id, add: [b.id] },
      opts,
    );
    expect(out).toMatchObject({
      __draft: true,
      tool: "edit_task_links",
      draft: {
        projectId: project.id,
        predecessorId: a.id,
        predecessorTitle: "前置",
        predecessorParentTaskId: null,
        currentSuccessors: [],
        add: [b.id],
        remove: [],
      },
    });
    expect(await db.select().from(taskDependencies)).toHaveLength(0);

    // 什么都不改就拟草案没有意义：在工具这层就说清楚，别让用户点确认才炸
    await expect(tools.edit_task_links.execute!({ predecessorId: a.id }, opts)).rejects.toThrow(
      "请至少给出要新增或移除的后置任务",
    );
  });

  it("update_tasks 产草案，为每个 update 填入当前 updatedAt", async () => {
    const { student, project } = await scene();
    const t = await createTask(student.id, project.id, { title: "甲" });
    const tools = buildTools(student.id, project.id);
    const out = (await tools.update_tasks.execute!(
      { updates: [{ taskId: t.id, patch: { status: "doing" } }] },
      opts,
    )) as { draft: { updates: { taskId: string; updatedAt: string; patch: unknown }[] } };
    expect(out.draft.updates[0].taskId).toBe(t.id);
    expect(typeof out.draft.updates[0].updatedAt).toBe("string");
    expect(out.draft.updates[0].patch).toEqual({ status: "doing" });
  });
});
