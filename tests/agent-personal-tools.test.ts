import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { personalContexts } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject, createMilestone } from "@/lib/project";
import { createTask } from "@/lib/task";
import {
  buildPersonalTools,
  buildTools,
  COMMIT_TOOL_NAMES,
  SAVE_CONTEXT_TOOL,
  WRITE_TOOL_NAMES,
} from "@/lib/agent/tools";
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
  // 外人的另一个团队与项目：student 一点边都不沾
  const otherTeam = await createTeam(outsider.id, "别人家的队伍");
  const otherProject = await createProject(outsider.id, otherTeam.id, { name: "机密项目" });
  await createTask(outsider.id, otherProject.id, { title: "外人的活" });
  return { owner, team, student, outsider, project, otherProject };
}

// AI SDK 的 tool.execute 签名为 (input, options)；测试直调传占位 options
const opts = {} as never;

describe("buildPersonalTools：跨项目读工具靠 projectId，权限仍逐层收敛", () => {
  beforeEach(resetDb);

  it("给全的读工具与写工具，且不带项目模式的隐含项目", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "create_milestone",
        "create_project",
        "decompose_tasks",
        "list_members",
        "list_milestones",
        "list_projects",
        "list_tasks",
        "plan_sprint",
        "query_progress",
        "save_personal_context",
        "update_tasks",
      ].sort(),
    );
    // 项目模式没有这两件：成员段常驻快照，上下文是控制台助手的事
    const projectTools = buildTools(student.id, "whatever");
    expect(projectTools).not.toHaveProperty("list_members");
    expect(projectTools).not.toHaveProperty("save_personal_context");
  });

  it("list_projects 只列我参与的项目", async () => {
    const { student, project } = await scene();
    const tools = buildPersonalTools(student.id);
    const rows = (await tools.list_projects.execute!(opts, opts)) as { id: string; name: string }[];
    expect(rows.map((r) => r.id)).toEqual([project.id]);
    expect(JSON.stringify(rows)).not.toContain("机密项目");
  });

  it("query_progress / list_tasks / list_milestones 都要 projectId，且照常受权限约束", async () => {
    const { student, owner, project, otherProject } = await scene();
    // 里程碑只有 admin 能建 —— 这里造的是「学生看得到的项目数据」，不是要看学生的写权限
    await createMilestone(owner.id, project.id, { title: "中期答辩" });
    await createTask(student.id, project.id, { title: "我的活", assigneeId: student.id });
    const tools = buildPersonalTools(student.id);

    const prog = (await tools.query_progress.execute!({ projectId: project.id }, opts)) as {
      taskTotal: number;
      milestoneTotal: number;
    };
    expect(prog.taskTotal).toBe(1);
    expect(prog.milestoneTotal).toBe(1);

    const ms = (await tools.list_milestones.execute!({ projectId: project.id }, opts)) as {
      title: string;
    }[];
    expect(ms.map((m) => m.title)).toEqual(["中期答辩"]);

    const ts = (await tools.list_tasks.execute!(
      { projectId: project.id, status: "todo" as const },
      opts,
    )) as { title: string }[];
    expect(ts.map((t) => t.title)).toEqual(["我的活"]);

    // 无权访问的项目：三个工具一律「没有权限」，而不是漏出别人的数据
    await expect(tools.query_progress.execute!({ projectId: otherProject.id }, opts)).rejects.toThrow(
      "没有权限",
    );
    await expect(
      tools.list_tasks.execute!({ projectId: otherProject.id }, opts),
    ).rejects.toThrow("没有权限");
    await expect(
      tools.list_milestones.execute!({ projectId: otherProject.id }, opts),
    ).rejects.toThrow("没有权限");
  });

  it("list_members 取项目所属团队的成员，非成员调不动", async () => {
    const { student, project, otherProject } = await scene();
    const tools = buildPersonalTools(student.id);
    const rows = (await tools.list_members.execute!({ projectId: project.id }, opts)) as {
      name: string;
      role: string;
    }[];
    expect(rows.map((r) => r.name).sort()).toEqual(["owner", "student"]);
    expect(rows.every((r) => typeof r.role === "string")).toBe(true);

    await expect(tools.list_members.execute!({ projectId: otherProject.id }, opts)).rejects.toThrow(
      "没有权限",
    );
  });

  it("写工具产草案且草案自带 projectId，一张卡都不落库", async () => {
    const { student, project } = await scene();
    const tools = buildPersonalTools(student.id);

    const out = await tools.create_milestone.execute!(
      { projectId: project.id, title: "中期答辩" },
      opts,
    );
    expect(out).toMatchObject({
      __draft: true,
      tool: "create_milestone",
      draft: { projectId: project.id, title: "中期答辩" },
    });

    const proj = await tools.create_project.execute!(
      { teamId: project.teamId, name: "新项目" },
      opts,
    );
    expect(proj).toMatchObject({
      __draft: true,
      tool: "create_project",
      draft: { teamId: project.teamId, name: "新项目" },
    });

    const ctx = await tools.save_personal_context.execute!(
      { entries: [{ content: "每周三下午有课" }] },
      opts,
    );
    expect(ctx).toMatchObject({
      __draft: true,
      tool: "save_personal_context",
      draft: { entries: [{ content: "每周三下午有课" }] },
    });

    expect(await db.select().from(personalContexts)).toHaveLength(0);
  });

  it("update_tasks 草案补上读时版本号（乐观锁）", async () => {
    const { student, project } = await scene();
    const task = await createTask(student.id, project.id, { title: "甲" });
    const tools = buildPersonalTools(student.id);
    const out = (await tools.update_tasks.execute!(
      {
        projectId: project.id,
        updates: [{ taskId: task.id, patch: { status: "done" as const } }],
      },
      opts,
    )) as { draft: { updates: { taskId: string; updatedAt: string }[] } };
    expect(out.draft.updates[0].taskId).toBe(task.id);
    expect(out.draft.updates[0].updatedAt).toBe(task.updatedAt.toISOString());
  });

  it("save_personal_context 不并进 WRITE_TOOL_NAMES，但进可落库清单", () => {
    expect(WRITE_TOOL_NAMES).toHaveLength(5);
    expect(WRITE_TOOL_NAMES).not.toContain(SAVE_CONTEXT_TOOL);
    expect(COMMIT_TOOL_NAMES).toEqual([...WRITE_TOOL_NAMES, SAVE_CONTEXT_TOOL]);
  });
});
