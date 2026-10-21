import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam, updateMemberRole } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, listProjectTasks } from "@/lib/task";
import { createLabel, listTeamLabels } from "@/lib/label";
import { listTeamResourceUsages } from "@/lib/resource";
import { buildPersonalTools } from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { resetDb } from "./helpers";

/**
 * 团队资源占用与标签的助手工具面。
 *
 * 这里测的是**边界与口径**，不是 SQL：
 * - 拟稿不落库；权限在拟稿期就提前报错（省得用户点确认才被拒）
 * - 资源时间是用户本地墙面时间，落库按用户时区换算
 * - 标签增量 add/remove 在草案里落成**最终全量集合**，落库仍走 setTaskLabels
 */

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
  const task = await createTask(student.id, project.id, { title: "写开题报告" });
  return { owner, team, student, outsider, project, task };
}

const opts = {} as never;

type Envelope = {
  __draft?: true;
  tool: string;
  draft: Record<string, unknown>;
};

// AI SDK 的工具在对象里是联合类型，按名字取出来调不动；这里统一收成一个可调形状
async function callTool(tools: object, name: string, input: unknown): Promise<unknown> {
  const entry = (tools as Record<string, unknown>)[name] as {
    execute: (input: unknown, options: unknown) => Promise<unknown>;
  };
  return entry.execute(input, opts);
}

async function draftOf(tools: object, name: string, input: unknown): Promise<Envelope> {
  return (await callTool(tools, name, input)) as Envelope;
}

describe("资源占用工具", () => {
  beforeEach(resetDb);

  it("list_resource_usages：成员可读，带 usageId 与汇总；非成员被拒", async () => {
    const { owner, team, student, outsider } = await scene();
    const tools = buildPersonalTools(student.id);

    const created = await draftOf(tools, "create_resource_usage", {
      teamId: team.id,
      resourceName: "GPU-01",
      purpose: "训练模型",
      startTime: "2026-11-01T09:30",
      endTime: "2026-11-01T11:00",
    });
    // 拟稿不落库
    expect(await listTeamResourceUsages(owner.id, team.id)).toMatchObject({ usages: [] });
    await commitPersonalDraft(student.id, created.tool as "create_resource_usage", created.draft);

    const out = (await callTool(tools, "list_resource_usages", { teamId: team.id })) as {
      team: { id: string; name: string };
      activeCount: number;
      total: number;
      usages: {
        usageId: string;
        resourceName: string;
        userName: string;
        active: boolean;
        durationMinutes: number | null;
      }[];
      byUser: { userId: string; totalMinutes: number }[];
      byResource: { resourceName: string; totalMinutes: number }[];
    };
    expect(out.team).toEqual({ id: team.id, name: "东吴实验室" });
    expect(out.activeCount).toBe(0);
    expect(out.total).toBe(1);
    expect(out.usages[0]).toMatchObject({
      resourceName: "GPU-01",
      userName: "student",
      active: false,
      durationMinutes: 90,
    });
    expect(out.byUser[0]).toMatchObject({ userId: student.id, totalMinutes: 90 });
    expect(out.byResource[0]).toMatchObject({ resourceName: "GPU-01", totalMinutes: 90 });

    const outsiderTools = buildPersonalTools(outsider.id);
    await expect(outsiderTools.list_resource_usages.execute!({ teamId: team.id }, opts)).rejects.toThrow(
      "没有权限",
    );
  });

  it("create_resource_usage：草案带团队名与规范化时间；结束早于开始当场被拒", async () => {
    const { team, student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = await draftOf(tools, "create_resource_usage", {
      teamId: team.id,
      resourceName: "  GPU-01  ",
      startTime: "2026-11-01T09:30",
      // 没给结束：草案里是 null，卡片据此显示「仍在占用」
    });
    expect(env).toMatchObject({
      __draft: true,
      tool: "create_resource_usage",
      draft: {
        teamId: team.id,
        teamName: "东吴实验室",
        resourceName: "GPU-01",
        purpose: null,
        startTime: "2026-11-01T09:30",
        endTime: null,
      },
    });

    await expect(
      tools.create_resource_usage.execute!(
        {
          teamId: team.id,
          resourceName: "GPU-01",
          startTime: "2026-11-01T11:00",
          endTime: "2026-11-01T09:30",
        },
        opts,
      ),
    ).rejects.toThrow("结束时间须晚于开始时间");

    await expect(
      tools.create_resource_usage.execute!(
        { teamId: team.id, resourceName: "GPU-01", startTime: "明天下午" },
        opts,
      ),
    ).rejects.toThrow("格式无效");
  });

  it("create_resource_usage 落库：按用户时区把墙面时间换算成时刻", async () => {
    const { team, student } = await scene();
    const tools = buildPersonalTools(student.id);
    const env = await draftOf(tools, "create_resource_usage", {
      teamId: team.id,
      resourceName: "GPU-01",
      startTime: "2026-11-01T09:30",
      endTime: "2026-11-01T11:00",
    });
    await commitPersonalDraft(student.id, "create_resource_usage", env.draft);

    const { usages } = await listTeamResourceUsages(student.id, team.id);
    // 默认时区 Asia/Shanghai：09:30 当地 = 01:30Z
    expect(usages[0].startTime.toISOString()).toBe("2026-11-01T01:30:00.000Z");
    expect(usages[0].endTime?.toISOString()).toBe("2026-11-01T03:00:00.000Z");
  });

  it("end_resource_usage：本人与 admin 可拟；他人、已结束都被拒", async () => {
    const { owner, team, student } = await scene();
    const studentTools = buildPersonalTools(student.id);
    const created = await draftOf(studentTools, "create_resource_usage", {
      teamId: team.id,
      resourceName: "GPU-01",
      startTime: "2026-11-01T09:30",
    });
    await commitPersonalDraft(student.id, "create_resource_usage", created.draft);
    const [usage] = (await listTeamResourceUsages(student.id, team.id)).usages;

    // 登记者本人
    const own = await draftOf(studentTools, "end_resource_usage", { usageId: usage.id });
    expect(own).toMatchObject({
      tool: "end_resource_usage",
      draft: {
        usageId: usage.id,
        teamName: "东吴实验室",
        resourceName: "GPU-01",
        userName: "student",
      },
    });

    // 团队 admin 也可以（student 只是成员，没有别的 member 能替 — 用另一个场景更直接）
    const ownerTools = buildPersonalTools(owner.id);
    await expect(
      ownerTools.end_resource_usage.execute!({ usageId: usage.id }, opts),
    ).resolves.toMatchObject({ tool: "end_resource_usage" });

    // 落库后就不再有「进行中」可结束
    await commitPersonalDraft(student.id, "end_resource_usage", own.draft);
    await expect(
      studentTools.end_resource_usage.execute!({ usageId: usage.id }, opts),
    ).rejects.toThrow("已结束");
  });

  it("end_resource_usage：非登记人非 admin 拟稿即被拒", async () => {
    const { team, student, outsider } = await scene();
    const studentTools = buildPersonalTools(student.id);
    const created = await draftOf(studentTools, "create_resource_usage", {
      teamId: team.id,
      resourceName: "GPU-01",
      startTime: "2026-11-01T09:30",
    });
    await commitPersonalDraft(student.id, "create_resource_usage", created.draft);
    const [usage] = (await listTeamResourceUsages(student.id, team.id)).usages;

    const outsiderTools = buildPersonalTools(outsider.id);
    await expect(
      outsiderTools.end_resource_usage.execute!({ usageId: usage.id }, opts),
    ).rejects.toThrow("没有权限");
  });
});

describe("标签工具", () => {
  beforeEach(resetDb);

  it("list_labels：成员可读，canManage 反映是否 admin", async () => {
    const { owner, team, student } = await scene();
    await createLabel(owner.id, team.id, { name: "论文", color: "red" });

    const asOwner = (await callTool(buildPersonalTools(owner.id), "list_labels", {
      teamId: team.id,
    })) as {
      team: { id: string; name: string };
      canManage: boolean;
      labels: { labelId: string; name: string; color: string; usageCount: number }[];
    };
    expect(asOwner.team).toEqual({ id: team.id, name: "东吴实验室" });
    expect(asOwner.canManage).toBe(true);
    expect(asOwner.labels).toEqual([
      expect.objectContaining({ name: "论文", color: "red", usageCount: 0 }),
    ]);

    const asStudent = (await callTool(buildPersonalTools(student.id), "list_labels", {
      teamId: team.id,
    })) as { canManage: boolean };
    expect(asStudent.canManage).toBe(false);
  });

  it("create_label / update_label / delete_label：仅 admin，草案可原样落库", async () => {
    const { owner, team, student } = await scene();
    const ownerTools = buildPersonalTools(owner.id);
    const studentTools = buildPersonalTools(student.id);

    await expect(
      studentTools.create_label.execute!({ teamId: team.id, name: "论文" }, opts),
    ).rejects.toThrow("没有权限");

    const created = await draftOf(ownerTools, "create_label", {
      teamId: team.id,
      name: "  论文  ",
      color: "blue",
    });
    expect(created).toMatchObject({
      tool: "create_label",
      draft: { teamId: team.id, teamName: "东吴实验室", name: "论文", color: "blue" },
    });
    await commitPersonalDraft(owner.id, "create_label", created.draft);
    const [label] = await listTeamLabels(owner.id, team.id);

    // 重名（含大小写差异）在拟稿期就拦
    await expect(
      ownerTools.create_label.execute!({ teamId: team.id, name: "论文" }, opts),
    ).rejects.toThrow("标签已存在");

    await expect(
      studentTools.update_label.execute!({ labelId: label.id, name: "改名" }, opts),
    ).rejects.toThrow("没有权限");

    const renamed = await draftOf(ownerTools, "update_label", {
      labelId: label.id,
      name: "小论文",
      color: "violet",
    });
    expect(renamed).toMatchObject({
      tool: "update_label",
      draft: {
        labelId: label.id,
        teamName: "东吴实验室",
        currentName: "论文",
        currentColor: "blue",
        name: "小论文",
        color: "violet",
      },
    });
    await commitPersonalDraft(owner.id, "update_label", renamed.draft);
    expect((await listTeamLabels(owner.id, team.id))[0]).toMatchObject({
      name: "小论文",
      color: "violet",
    });

    await expect(
      ownerTools.update_label.execute!({ labelId: label.id }, opts),
    ).rejects.toThrow("至少给出新的名称或颜色");

    const removed = await draftOf(ownerTools, "delete_label", { labelId: label.id });
    expect(removed).toMatchObject({
      tool: "delete_label",
      draft: { labelId: label.id, teamName: "东吴实验室", name: "小论文" },
    });
    await commitPersonalDraft(owner.id, "delete_label", removed.draft);
    expect(await listTeamLabels(owner.id, team.id)).toEqual([]);
  });

  it("edit_task_labels：增量语义落成最终集合", async () => {
    const { owner, team, student, task } = await scene();
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    const code = await createLabel(owner.id, team.id, { name: "代码" });
    const tools = buildPersonalTools(student.id);

    const first = await draftOf(tools, "edit_task_labels", {
      taskId: task.id,
      add: [paper.id],
    });
    expect(first).toMatchObject({
      tool: "edit_task_labels",
      draft: {
        taskId: task.id,
        taskTitle: "写开题报告",
        labelIds: [paper.id],
        currentLabelIds: [],
      },
    });
    // 草案里带团队全部标签，卡片据此渲染复选框
    expect((first.draft.labels as { id: string }[]).map((l) => l.id).sort()).toEqual(
      [paper.id, code.id].sort(),
    );
    await commitPersonalDraft(student.id, "edit_task_labels", first.draft);

    const second = await draftOf(tools, "edit_task_labels", {
      taskId: task.id,
      add: [code.id],
      remove: [paper.id],
    });
    expect(second.draft.labelIds).toEqual([code.id]);
    expect(second.draft.currentLabelIds).toEqual([paper.id]);
    await commitPersonalDraft(student.id, "edit_task_labels", second.draft);

    const [row] = await listProjectTasks(student.id, task.projectId);
    expect(row.labels.map((l) => l.name)).toEqual(["代码"]);
  });

  it("edit_task_labels：空动作 / 既加又删 / 已在任务上 / 不在任务上 / 无变化都被拒", async () => {
    const { owner, team, student, task } = await scene();
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    const tools = buildPersonalTools(student.id);

    await expect(
      tools.edit_task_labels.execute!({ taskId: task.id }, opts),
    ).rejects.toThrow("至少给出要添加或移除的标签");
    await expect(
      tools.edit_task_labels.execute!({ taskId: task.id, add: [paper.id], remove: [paper.id] }, opts),
    ).rejects.toThrow("不能既添加又移除");
    await expect(
      tools.edit_task_labels.execute!({ taskId: task.id, remove: [paper.id] }, opts),
    ).rejects.toThrow("任务没有标签");

    const env = await draftOf(tools, "edit_task_labels", { taskId: task.id, add: [paper.id] });
    await commitPersonalDraft(student.id, "edit_task_labels", env.draft);
    await expect(
      tools.edit_task_labels.execute!({ taskId: task.id, add: [paper.id] }, opts),
    ).rejects.toThrow("任务已有标签");
  });

  it("edit_task_labels：跨团队标签与非写权限角色被拒", async () => {
    const { owner, team, student, task } = await scene();

    const other = await makeUser("other-admin@example.com");
    const otherTeam = await createTeam(other.id, "西蜀实验室");
    const alien = await createLabel(other.id, otherTeam.id, { name: "外营标签" });

    const tools = buildPersonalTools(student.id);
    await expect(
      tools.edit_task_labels.execute!({ taskId: task.id, add: [alien.id] }, opts),
    ).rejects.toThrow("不属于该团队");

    // teacher 在项目里是只读角色
    const teacher = await makeUser("teacher@example.com");
    await joinTeam(teacher.id, team.inviteCode);
    await updateMemberRole(owner.id, team.id, teacher.id, "teacher");
    const paper = await createLabel(owner.id, team.id, { name: "论文" });
    await expect(
      buildPersonalTools(teacher.id).edit_task_labels.execute!(
        { taskId: task.id, add: [paper.id] },
        opts,
      ),
    ).rejects.toThrow("没有权限");
  });
});
