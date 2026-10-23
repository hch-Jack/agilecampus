import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { resolveNavigation } from "@/lib/agent/navigation";
import { buildPersonalTools } from "@/lib/agent/tools";
import { resetDb } from "./helpers";

/**
 * 助手「打开页面」的口径。
 *
 * 模型只报目标与 id，路径由这里生成 —— 这里钉住的是**白名单、id 来源与权限**：
 * 页面路径不许由模型自由拼，目标页面也得先过项目/团队/任务的访问校验。
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
  const task = await createTask(owner.id, project.id, { title: "写开题报告" });
  return { owner, team, student, outsider, project, task };
}

const opts = {} as never;

describe("resolveNavigation：固定页面", () => {
  beforeEach(resetDb);

  it("工作台 / 消息 / 设置等无需 id，直接给出路径", async () => {
    const { student } = await scene();
    await expect(resolveNavigation(student.id, { target: "dashboard" })).resolves.toEqual({
      label: "工作台",
      href: "/dashboard",
    });
    await expect(resolveNavigation(student.id, { target: "settings" })).resolves.toEqual({
      label: "AI 设置",
      href: "/settings",
    });
    await expect(resolveNavigation(student.id, { target: "messages" })).resolves.toEqual({
      label: "消息",
      href: "/messages",
    });
    await expect(resolveNavigation(student.id, { target: "teams" })).resolves.toEqual({
      label: "我的团队",
      href: "/teams",
    });
  });
});

describe("resolveNavigation：项目与任务", () => {
  beforeEach(resetDb);

  it("项目成员可打开看板/关系图/流程图/时间线", async () => {
    const { student, project } = await scene();
    await expect(
      resolveNavigation(student.id, { target: "project", projectId: project.id }),
    ).resolves.toEqual({ label: "赤壁演习", href: `/projects/${project.id}` });
    await expect(
      resolveNavigation(student.id, { target: "project_graph", projectId: project.id }),
    ).resolves.toEqual({ label: "赤壁演习 · 关系图", href: `/projects/${project.id}/graph` });
    await expect(
      resolveNavigation(student.id, { target: "project_timeline", projectId: project.id }),
    ).resolves.toEqual({ label: "赤壁演习 · 时间线", href: `/projects/${project.id}/timeline` });
  });

  it("缺 projectId / teamId / taskId 时报可读的错", async () => {
    const { student } = await scene();
    await expect(resolveNavigation(student.id, { target: "project" })).rejects.toThrow(
      "需要 projectId",
    );
    await expect(resolveNavigation(student.id, { target: "team_resources" })).rejects.toThrow(
      "需要 teamId",
    );
    await expect(resolveNavigation(student.id, { target: "task" })).rejects.toThrow("需要 taskId");
  });

  it("非成员打开项目或任务被拒", async () => {
    const { outsider, project, task } = await scene();
    await expect(
      resolveNavigation(outsider.id, { target: "project", projectId: project.id }),
    ).rejects.toThrow("无权访问");
    await expect(
      resolveNavigation(outsider.id, { target: "task", taskId: task.id }),
    ).rejects.toThrow("没有权限");
  });

  it("任务页由任务自己带出所属项目与标题", async () => {
    const { student, project, task } = await scene();
    await expect(
      resolveNavigation(student.id, { target: "task", taskId: task.id }),
    ).resolves.toEqual({
      label: "任务「写开题报告」",
      href: `/projects/${project.id}/tasks/${task.id}`,
    });
  });
});

describe("resolveNavigation：团队页面", () => {
  beforeEach(resetDb);

  it("成员可打开团队四个子页，路径与标签随团队名", async () => {
    const { student, team } = await scene();
    await expect(
      resolveNavigation(student.id, { target: "team_resources", teamId: team.id }),
    ).resolves.toEqual({
      label: "东吴实验室 · 资源占用",
      href: `/teams/${team.id}/resources`,
    });
    await expect(
      resolveNavigation(student.id, { target: "team_labels", teamId: team.id }),
    ).resolves.toEqual({ label: "东吴实验室 · 标签", href: `/teams/${team.id}/labels` });
    await expect(
      resolveNavigation(student.id, { target: "team_members", teamId: team.id }),
    ).resolves.toEqual({ label: "东吴实验室 · 成员", href: `/teams/${team.id}/members` });
    await expect(
      resolveNavigation(student.id, { target: "team_projects", teamId: team.id }),
    ).resolves.toEqual({ label: "东吴实验室 · 项目", href: `/teams/${team.id}/projects` });
  });

  it("非成员被拒", async () => {
    const { outsider, team } = await scene();
    await expect(
      resolveNavigation(outsider.id, { target: "team_resources", teamId: team.id }),
    ).rejects.toThrow("没有权限");
  });
});

describe("open_page 工具", () => {
  beforeEach(resetDb);

  it("返回带 __navigate 标记的信封，供编排器收集", async () => {
    const { student, project } = await scene();
    const tools = buildPersonalTools(student.id);
    const out = (await tools.open_page.execute!(
      { target: "project", projectId: project.id },
      opts,
    )) as { __navigate: true; label: string; href: string };
    expect(out).toEqual({
      __navigate: true,
      label: "赤壁演习",
      href: `/projects/${project.id}`,
    });
  });

  it("项目 scope 没有这件工具，也就跳不了页面", async () => {
    const { student, project } = await scene();
    const { buildTools } = await import("@/lib/agent/tools");
    expect(buildTools(student.id, project.id)).not.toHaveProperty("open_page");
  });
});
