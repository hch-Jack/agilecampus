import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject, createMilestone } from "@/lib/project";
import { createTask, setTaskSuccessors } from "@/lib/task";
import { queryProgress, listTasksFiltered, buildTools } from "@/lib/agent/tools";
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

describe("queryProgress", () => {
  beforeEach(resetDb);

  it("汇总任务状态计数与里程碑概况", async () => {
    const { owner, student, project } = await scene();
    await createMilestone(owner.id, project.id, { title: "中期答辩", targetDate: "2026-11-15" });
    await createTask(student.id, project.id, { title: "甲" });
    await createTask(student.id, project.id, { title: "乙" });

    const r = await queryProgress(student.id, project.id);
    expect(r.taskTotal).toBe(2);
    expect(r.byStatus.todo).toBe(2);
    expect(r.byStatus.doing).toBe(0);
    expect(r.milestoneTotal).toBe(1);
    expect(r.milestones[0].title).toBe("中期答辩");
  });

  it("非成员被拒（复用 lib 权限）", async () => {
    const { outsider, project } = await scene();
    await expect(queryProgress(outsider.id, project.id)).rejects.toThrow("没有权限");
  });
});

describe("listTasksFiltered", () => {
  beforeEach(resetDb);

  it("按状态与负责人筛选", async () => {
    const { student, project } = await scene();
    await createTask(student.id, project.id, { title: "甲", assigneeId: student.id });
    await createTask(student.id, project.id, { title: "乙" });

    const all = await listTasksFiltered(student.id, project.id, {});
    expect(all).toHaveLength(2);

    const mine = await listTasksFiltered(student.id, project.id, { assigneeId: student.id });
    expect(mine).toHaveLength(1);
    expect(mine[0].title).toBe("甲");
    expect(mine[0].assigneeName).toBe("student");

    const todos = await listTasksFiltered(student.id, project.id, { status: "todo" });
    expect(todos).toHaveLength(2);
  });

  it("按截止日筛（dueBefore 含当日）", async () => {
    const { student, project } = await scene();
    await createTask(student.id, project.id, { title: "早", dueDate: "2026-10-01" });
    await createTask(student.id, project.id, { title: "晚", dueDate: "2026-12-01" });
    const due = await listTasksFiltered(student.id, project.id, { dueBefore: "2026-10-31" });
    expect(due).toHaveLength(1);
    expect(due[0].title).toBe("早");
  });

  it("列表带上起始日（助手排期要知道任务从哪天开始）", async () => {
    const { student, project } = await scene();
    await createTask(student.id, project.id, { title: "甲", startDate: "2026-10-02" });
    const [row] = await listTasksFiltered(student.id, project.id, {});
    expect(row.startDate).toBe("2026-10-02");
  });
});

describe("buildTools — 任务详情与依赖读工具", () => {
  beforeEach(resetDb);
  const opts = {} as never;

  it("get_task_detail 返回完整详情；项目版拒绝别的项目的任务", async () => {
    const { owner, team, student, project } = await scene();
    const other = await createProject(owner.id, team.id, { name: "另一项目" });
    const mine = await createTask(student.id, project.id, { title: "我的", description: "细节" });
    const theirs = await createTask(owner.id, other.id, { title: "人家的" });
    const tools = buildTools(student.id, project.id);

    const d = (await tools.get_task_detail.execute!({ taskId: mine.id }, opts)) as {
      description: string;
      predecessors: unknown[];
      successors: unknown[];
    };
    expect(d.description).toBe("细节");
    expect(d.predecessors).toEqual([]);
    expect(d.successors).toEqual([]);

    await expect(tools.get_task_detail.execute!({ taskId: theirs.id }, opts)).rejects.toThrow(
      "任务不属于该项目",
    );
  });

  it("list_dependencies 返回带标题与 crossLevel 的边", async () => {
    const { student, project } = await scene();
    const a = await createTask(student.id, project.id, { title: "甲" });
    const b = await createTask(student.id, project.id, { title: "乙" });
    await setTaskSuccessors(student.id, a.id, [b.id]);

    const tools = buildTools(student.id, project.id);
    const rows = (await tools.list_dependencies.execute!(opts, opts)) as {
      predecessorTitle: string;
      successorTitle: string;
      crossLevel: boolean;
    }[];
    expect(rows).toEqual([
      expect.objectContaining({
        predecessorTitle: "甲",
        successorTitle: "乙",
        crossLevel: false,
      }),
    ]);
  });
});
