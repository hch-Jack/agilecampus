import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks, projects } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject, createMilestone, listProjectMilestones } from "@/lib/project";
import {
  createTask,
  listProjectDependencies,
  listProjectTasks,
  updateTask,
} from "@/lib/task";
import { commitDraft, commitPersonalDraft } from "@/lib/agent/commit";
import { listMyPersonalContext } from "@/lib/personal-context";
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

describe("commitDraft — decompose_tasks", () => {
  beforeEach(resetDb);

  it("student 确认拆解草案 → 批量落库", async () => {
    const { student, project } = await scene();
    const r = await commitDraft(student.id, project.id, "decompose_tasks", {
      tasks: [{ title: "甲" }, { title: "乙", priority: "high" }],
    });
    expect(r.committed).toBe(2);
    const rows = await db.select().from(tasks).where(eq(tasks.projectId, project.id));
    expect(rows).toHaveLength(2);
  });

  it("非成员草案落库被拒", async () => {
    const { outsider, project } = await scene();
    await expect(
      commitDraft(outsider.id, project.id, "decompose_tasks", { tasks: [{ title: "越权" }] }),
    ).rejects.toThrow("没有权限");
  });
});

describe("commitDraft — create_project", () => {
  beforeEach(resetDb);

  it("admin 确认建项目草案 → 落库于同团队", async () => {
    const { owner, team, project } = await scene();
    const r = await commitDraft(owner.id, project.id, "create_project", { name: "新项目" });
    expect(r.committed).toBe(1);
    const rows = await db.select().from(projects).where(eq(projects.teamId, team.id));
    expect(rows.some((p) => p.name === "新项目")).toBe(true);
  });

  it("student 建项目草案落库被拒（仅 admin）", async () => {
    const { student, project } = await scene();
    await expect(
      commitDraft(student.id, project.id, "create_project", { name: "私设" }),
    ).rejects.toThrow("没有权限");
  });
});

describe("commitDraft — update_tasks 版本校验", () => {
  beforeEach(resetDb);

  it("版本一致 → 落库", async () => {
    const { student, project } = await scene();
    const t = await createTask(student.id, project.id, { title: "甲" });
    const [row] = await listProjectTasks(student.id, project.id);
    const r = await commitDraft(student.id, project.id, "update_tasks", {
      updates: [{ taskId: t.id, updatedAt: row.updatedAt.toISOString(), patch: { status: "doing" } }],
    });
    expect(r.committed).toBe(1);
    expect(r.conflicts).toHaveLength(0);
    const [after] = await listProjectTasks(student.id, project.id);
    expect(after.status).toBe("doing");
  });

  it("版本过期（updatedAt 不符）→ 冲突、不落库", async () => {
    const { owner, student, project } = await scene();
    const t = await createTask(student.id, project.id, { title: "甲" });
    // 学生完成已被审批流拦截（approval.test.ts 专测）；这里只为制造版本变化
    await updateTask(owner.id, t.id, { status: "done" });
    const r = await commitDraft(student.id, project.id, "update_tasks", {
      updates: [
        { taskId: t.id, updatedAt: "2000-01-01T00:00:00.000Z", patch: { status: "doing" } },
      ],
    });
    expect(r.committed).toBe(0);
    expect(r.conflicts).toEqual([t.id]);
    const [after] = await listProjectTasks(student.id, project.id);
    expect(after.status).toBe("done");
  });
});

describe("commitDraft — plan_sprint", () => {
  beforeEach(resetDb);

  it("归入里程碑 + 批量设截止日（免版本校验）", async () => {
    const { owner, student, project } = await scene();
    const m = await createMilestone(owner.id, project.id, { title: "冲刺一" });
    const t1 = await createTask(student.id, project.id, { title: "甲" });
    const t2 = await createTask(student.id, project.id, { title: "乙" });
    const r = await commitDraft(student.id, project.id, "plan_sprint", {
      milestoneId: m.id,
      taskIds: [t1.id, t2.id],
      dueDate: "2026-11-30",
    });
    expect(r.committed).toBe(2);
    const rows = await listProjectTasks(student.id, project.id);
    expect(rows.every((x) => x.milestoneId === m.id && x.dueDate === "2026-11-30")).toBe(true);
  });
});

describe("commitDraft 事务化", () => {
  beforeEach(resetDb);

  it("decompose 中途非法 milestoneId → 整批回滚（无残留）", async () => {
    const { owner, project } = await scene();
    // 第 2 个任务 milestoneId 非法 → validateMilestone 抛错 → 整批回滚
    await expect(
      commitDraft(owner.id, project.id, "decompose_tasks", {
        tasks: [
          { title: "合法一" },
          { title: "非法二", milestoneId: "00000000-0000-0000-0000-000000000000" },
        ],
      }),
    ).rejects.toThrow();

    const after = await listProjectTasks(owner.id, project.id);
    expect(after).toHaveLength(0); // 「合法一」不得残留
  });
});

describe("commitPersonalDraft（控制台助手的落库口）", () => {
  beforeEach(resetDb);

  it("改任务草案的读时版本对不上 → 报冲突且不落库", async () => {
    const { student, project } = await scene();
    const task = await createTask(student.id, project.id, { title: "甲" });
    const r = await commitPersonalDraft(student.id, "update_tasks", {
      projectId: project.id,
      updates: [
        { taskId: task.id, updatedAt: new Date(0).toISOString(), patch: { status: "done" } },
      ],
    });
    expect(r).toEqual({ committed: 0, conflicts: [task.id] });
    const [after] = await listProjectTasks(student.id, project.id);
    expect(after.status).toBe("todo");
  });

  it("save_personal_context 记成 agent 来源，空条目被拒", async () => {
    const { student } = await scene();
    const r = await commitPersonalDraft(student.id, "save_personal_context", {
      entries: [{ content: "我在准备中期答辩" }],
    });
    expect(r).toEqual({ committed: 1, conflicts: [] });
    expect((await listMyPersonalContext(student.id))[0]).toMatchObject({
      content: "我在准备中期答辩",
      source: "agent",
      visibility: "shared",
    });

    await expect(
      commitPersonalDraft(student.id, "save_personal_context", { entries: [] }),
    ).rejects.toThrow("没有要保存的上下文");
  });

  it("改项目类的草案缺 projectId → 报出可诊断的错，而不是笼统的「草案格式无效」", async () => {
    const { student } = await scene();
    // 个人模式没有「当前项目」，projectId 只能来自草案。缺了它就直说，用户才知道该让助手重拟；
    // 从前这一句会被路由统一翻译成「草案格式无效」，看不出是谁漏了东西（见 tools.ts 的 update_tasks）。
    await expect(
      commitPersonalDraft(student.id, "create_milestone", { title: "中期答辩" }),
    ).rejects.toThrow("草案里没带项目 id");
  });

  it("create_project 的 teamId 缺了或填成团队名 → 同样报得出是哪一环缺", async () => {
    const { student } = await scene();
    // 与上面那四类同理：个人模式也没有「当前团队」，teamId 只能从草案里来
    await expect(commitPersonalDraft(student.id, "create_project", { name: "新项目" })).rejects.toThrow(
      "草案里没带团队 id",
    );
    await expect(
      commitPersonalDraft(student.id, "create_project", { teamId: "东吴实验室", name: "新项目" }),
    ).rejects.toThrow("草案里没带团队 id");
  });
});

// 卡片上把日期框**清空**，浏览器交出的是空串。它一路骗过 z.string() 与 lib 里 `if (d && …)` 的
// 真值判断，最后撞在 PG 的 date 列上（invalid input syntax for type date: ""）→ 用户看到 500
// 「落库失败，请重试」。这组用例把「空串」在这道门上的语义钉死。
describe("commitDraft — 任务详情字段与依赖增量", () => {
  beforeEach(resetDb);

  it("decompose_tasks 落起始日；空串视为没给而不是撞 date 列", async () => {
    const { student, project } = await scene();
    await commitDraft(student.id, project.id, "decompose_tasks", {
      tasks: [
        { title: "甲", startDate: "2026-10-01", dueDate: "2026-10-20" },
        { title: "乙", startDate: "" },
      ],
    });
    const rows = await listProjectTasks(student.id, project.id);
    expect(rows.find((t) => t.title === "甲")).toMatchObject({
      startDate: "2026-10-01",
      dueDate: "2026-10-20",
    });
    expect(rows.find((t) => t.title === "乙")?.startDate).toBeNull();
  });

  it("update_tasks：可改描述/起始日/完成说明；null 清空、空串不动", async () => {
    const { student, project } = await scene();
    const t = await createTask(student.id, project.id, {
      title: "甲",
      description: "旧描述",
      startDate: "2026-10-01",
    });

    await commitDraft(student.id, project.id, "update_tasks", {
      updates: [
        {
          taskId: t.id,
          updatedAt: t.updatedAt.toISOString(),
          patch: {
            description: "新描述",
            startDate: "2026-10-05",
            completionNote: "新完成说明",
          },
        },
      ],
    });
    let row = (await listProjectTasks(student.id, project.id))[0];
    expect(row).toMatchObject({
      description: "新描述",
      startDate: "2026-10-05",
      completionNote: "新完成说明",
    });

    await commitDraft(student.id, project.id, "update_tasks", {
      updates: [
        {
          taskId: t.id,
          updatedAt: row.updatedAt.toISOString(),
          patch: { description: null, startDate: null, completionNote: null },
        },
      ],
    });
    row = (await listProjectTasks(student.id, project.id))[0];
    expect(row).toMatchObject({ description: null, startDate: null, completionNote: null });

    // 空串 = 没给：先把值放回去，再确认空串不会把它清掉
    const back = (
      await updateTask(student.id, t.id, {
        description: "留着",
        startDate: "2026-10-02",
        completionNote: "留着",
      })
    ).updatedAt;
    await commitDraft(student.id, project.id, "update_tasks", {
      updates: [
        {
          taskId: t.id,
          updatedAt: back.toISOString(),
          patch: { description: "", startDate: "", completionNote: "" },
        },
      ],
    });
    expect((await listProjectTasks(student.id, project.id))[0]).toMatchObject({
      description: "留着",
      startDate: "2026-10-02",
      completionNote: "留着",
    });
  });

  it("edit_task_links 增量落库：只加/删提到的边，旧边保留", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    const c = await createTask(student.id, project.id, { title: "丙" });
    await commitDraft(student.id, project.id, "edit_task_links", {
      predecessorId: a.id,
      add: [b.id],
    });
    const r = await commitDraft(student.id, project.id, "edit_task_links", {
      predecessorId: a.id,
      add: [c.id],
      remove: [b.id],
    });
    expect(r).toEqual({ committed: 2, conflicts: [] });
    const deps = await listProjectDependencies(student.id, project.id);
    expect(deps).toEqual([{ predecessorId: a.id, successorId: c.id }]);
  });

  it("卡片展示字段被 zod 剥掉也不影响落库（不得 strict）", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    const r = await commitDraft(student.id, project.id, "edit_task_links", {
      predecessorId: a.id,
      predecessorTitle: "甲",
      predecessorParentTaskId: null,
      currentSuccessors: [],
      add: [b.id],
      remove: [],
      projectId: project.id,
    });
    expect(r.committed).toBe(1);
  });

  it("个人版：草案里的 projectId 与前置任务实际归属不一致 → 明确报错", async () => {
    const { owner, team, student, project } = await scene();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    await expect(
      commitPersonalDraft(student.id, "edit_task_links", {
        projectId: other.id,
        predecessorId: a.id,
        add: [b.id],
      }),
    ).rejects.toThrow("任务不属于该项目");
  });
});

describe("commitPersonalDraft — 日期字段的空串与 null", () => {
  beforeEach(resetDb);

  it("空串 = 没给：既不落库、也不报错，原值不动", async () => {
    const { student, project } = await scene();
    const task = await createTask(student.id, project.id, { title: "甲", dueDate: "2026-11-01" });
    const r = await commitPersonalDraft(student.id, "update_tasks", {
      projectId: project.id,
      updates: [{ taskId: task.id, updatedAt: task.updatedAt.toISOString(), patch: { dueDate: "" } }],
    });
    expect(r).toEqual({ committed: 1, conflicts: [] });
    expect((await listProjectTasks(student.id, project.id))[0].dueDate).toBe("2026-11-01");
  });

  it("null = 清掉这个日期（卡片上清空用法一栏时送的就是它）", async () => {
    const { student, project } = await scene();
    const task = await createTask(student.id, project.id, { title: "甲", dueDate: "2026-11-01" });
    const r = await commitPersonalDraft(student.id, "update_tasks", {
      projectId: project.id,
      updates: [{ taskId: task.id, updatedAt: task.updatedAt.toISOString(), patch: { dueDate: null } }],
    });
    expect(r).toEqual({ committed: 1, conflicts: [] });
    expect((await listProjectTasks(student.id, project.id))[0].dueDate).toBeNull();
  });

  it("新建项目/里程碑的空串日期也走同一条路（不撞 date 列）", async () => {
    const { owner, project, team } = await scene(); // 建项目/里程碑都要 admin
    const ms = await commitPersonalDraft(owner.id, "create_milestone", {
      projectId: project.id,
      title: "中期答辩",
      targetDate: "",
    });
    expect(ms).toEqual({ committed: 1, conflicts: [] });
    expect((await listProjectMilestones(owner.id, project.id))[0].targetDate).toBeNull();

    expect(
      await commitPersonalDraft(owner.id, "create_project", {
        teamId: team.id,
        name: "新项目",
        startDate: "",
        endDate: "2026-12-31",
      }),
    ).toEqual({ committed: 1, conflicts: [] });
    const [created] = await db.select().from(projects).where(eq(projects.name, "新项目"));
    expect(created.startDate).toBeNull(); // 空串 = 不设
    expect(created.endDate).toBe("2026-12-31"); // 给了的照常落
  });

  it("排期的截止日是必填：空串在这一关就被拦下，并说得出是谁", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(student.id, project.id, { title: "甲" });
    const milestone = await createMilestone(owner.id, project.id, { title: "中期答辩" });
    await expect(
      commitPersonalDraft(student.id, "plan_sprint", {
        projectId: project.id,
        milestoneId: milestone.id,
        taskIds: [task.id],
        dueDate: "",
      }),
    ).rejects.toThrow("排期要给截止日");
  });
});
