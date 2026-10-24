import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { personalContexts } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject, createMilestone } from "@/lib/project";
import { createSubtask, createTask, listProjectTasks, listSubtasks } from "@/lib/task";
import { listAttachments, uploadAttachment } from "@/lib/attachment";
import { commitPersonalDraft } from "@/lib/agent/commit";
import {
  ATTACH_MESSAGE_TOOL,
  buildPersonalTools,
  buildTools,
  COMMIT_TOOL_NAMES,
  CREATE_GROUP_TOOL,
  CREATE_LABEL_TOOL,
  CREATE_RESOURCE_USAGE_TOOL,
  CREATE_TEAM_TOOL,
  DELETE_LABEL_TOOL,
  EDIT_TASK_LABELS_TOOL,
  END_RESOURCE_USAGE_TOOL,
  FOCUS_PROJECT_TOOL_NAMES,
  FORWARD_MESSAGE_TOOL,
  INVITE_GROUP_TOOL,
  JOIN_TEAM_TOOL,
  RESPOND_INVITE_TOOL,
  SAVE_CONTEXT_TOOL,
  SEND_MESSAGE_TOOL,
  UPDATE_LABEL_TOOL,
  WRITE_TOOL_NAMES,
  type CommitToolName,
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
        "attach_message_file_to_task",
        "create_group_chat",
        "create_label",
        "create_milestone",
        "create_project",
        "create_resource_usage",
        "create_team",
        "decompose_tasks",
        "delete_label",
        "edit_task_labels",
        "edit_task_links",
        "end_resource_usage",
        "find_contact",
        "forward_message",
        "get_task_detail",
        "invite_to_group",
        "join_team",
        "list_attachments",
        "list_dependencies",
        "list_labels",
        "list_members",
        "list_message_threads",
        "list_milestones",
        "list_my_task_activity",
        "list_projects",
        "list_resource_usages",
        "list_tasks",
        "open_file",
        "open_message",
        "open_page",
        "plan_sprint",
        "query_progress",
        "read_messages",
        "respond_group_invite",
        "search_messages",
        "save_personal_context",
        "send_message",
        "update_label",
        "update_tasks",
      ].sort(),
    );
    // 项目模式没有这几件：成员段常驻快照，上下文与消息是控制台助手的事
    const projectTools = buildTools(student.id, "whatever");
    expect(projectTools).not.toHaveProperty("list_members");
    expect(projectTools).not.toHaveProperty("save_personal_context");
    expect(projectTools).not.toHaveProperty("list_message_threads");
    expect(projectTools).not.toHaveProperty("read_messages");
    expect(projectTools).not.toHaveProperty("search_messages");
    expect(projectTools).not.toHaveProperty("open_message");
    expect(projectTools).not.toHaveProperty("respond_group_invite");
    expect(projectTools).not.toHaveProperty("attach_message_file_to_task");
    // 发送 / 转发 / 建群只在工作台：项目页没有消息上下文，也没有发消息的入口
    expect(projectTools).not.toHaveProperty("find_contact");
    expect(projectTools).not.toHaveProperty("send_message");
    expect(projectTools).not.toHaveProperty("forward_message");
    expect(projectTools).not.toHaveProperty("create_group_chat");
    expect(projectTools).not.toHaveProperty("invite_to_group");
    // 个人模式反过来不重复项目内归档的读工具：项目页问「最近发生了什么」才查得到整套上下文
    expect(tools).not.toHaveProperty("list_project_activity");
    expect(tools).not.toHaveProperty("list_comments");
    expect(tools).not.toHaveProperty("list_chat_history");
    // 子任务与附件删除是项目助手的工具面；工作台有附件查看（发文件前取 attachmentId）
    // 与「消息文件 → 任务附件」，但不直接管子任务、不删附件
    expect(tools).not.toHaveProperty("create_subtask");
    expect(tools).not.toHaveProperty("delete_subtask");
    expect(tools).not.toHaveProperty("delete_attachment");
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

  it("open_file 只给有权限的附件发预览信封", async () => {
    const { owner, student, outsider, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "整理资料" });
    const file = await uploadAttachment(owner.id, task.id, {
      filename: "汇报.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 4,
      data: Buffer.from("test"),
    });
    const tools = buildPersonalTools(student.id);

    const out = (await tools.open_file.execute!(
      { attachmentId: file.id, source: "task" as const },
      opts,
    )) as Record<string, unknown>;
    expect(out).toEqual({
      __showFile: true,
      url: `/api/attachments/${file.id}`,
      filename: "汇报.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 4,
    });

    // 非项目成员：元数据都拿不到，更不会有预览 URL
    await expect(
      buildPersonalTools(outsider.id).open_file.execute!(
        { attachmentId: file.id, source: "task" as const },
        opts,
      ),
    ).rejects.toThrow();
    // 任务附件不能借「消息附件」的口子绕过校验
    await expect(
      tools.open_file.execute!({ attachmentId: file.id, source: "message" as const }, opts),
    ).rejects.toThrow();
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

  it("个人专属工具不并进 WRITE_TOOL_NAMES，但进可落库清单", () => {
    expect(WRITE_TOOL_NAMES).toHaveLength(9);
    expect(WRITE_TOOL_NAMES).not.toContain(SAVE_CONTEXT_TOOL);
    // 邀请处理只属于个人 scope：塞进 WRITE_TOOL_NAMES 会让项目页也能提交它
    expect(WRITE_TOOL_NAMES).not.toContain(RESPOND_INVITE_TOOL);
    // 消息附件复制同理：只有工作台助手能读消息
    expect(WRITE_TOOL_NAMES).not.toContain(ATTACH_MESSAGE_TOOL);
    // 发送 / 转发 / 建群同理：只走个人落库口，不能让项目页提交
    expect(WRITE_TOOL_NAMES).not.toContain(SEND_MESSAGE_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(FORWARD_MESSAGE_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(CREATE_GROUP_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(INVITE_GROUP_TOOL);
    // 资源占用与标签同理：全部只在工作台助手，项目页的落库口不该认它们
    expect(WRITE_TOOL_NAMES).not.toContain(CREATE_RESOURCE_USAGE_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(END_RESOURCE_USAGE_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(CREATE_LABEL_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(UPDATE_LABEL_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(DELETE_LABEL_TOOL);
    expect(WRITE_TOOL_NAMES).not.toContain(EDIT_TASK_LABELS_TOOL);
    expect(COMMIT_TOOL_NAMES).toEqual([
      ...WRITE_TOOL_NAMES,
      SAVE_CONTEXT_TOOL,
      RESPOND_INVITE_TOOL,
      ATTACH_MESSAGE_TOOL,
      SEND_MESSAGE_TOOL,
      FORWARD_MESSAGE_TOOL,
      CREATE_GROUP_TOOL,
      INVITE_GROUP_TOOL,
      CREATE_TEAM_TOOL,
      JOIN_TEAM_TOOL,
      CREATE_RESOURCE_USAGE_TOOL,
      END_RESOURCE_USAGE_TOOL,
      CREATE_LABEL_TOOL,
      UPDATE_LABEL_TOOL,
      DELETE_LABEL_TOOL,
      EDIT_TASK_LABELS_TOOL,
    ]);
  });
});

// 两个 scope 的分工不同：项目版的 projectId 由请求体给（工具 schema 里没有它），
// 个人版没有「当前项目」，只能从草案里取（见 commitPersonalDraft）。
// 工具漏带那个 id 时，卡片照常渲染、点「确认」才炸成「草案格式无效」——
// 曾经 update_tasks 就漏了 projectId，所以这里逐件把草案喂给落库口，兜住整类。
describe("个人写工具的草案，落库口都吃得下", () => {
  beforeEach(resetDb);

  it("六件写工具的草案都自带 projectId / teamId，且能原样落库", async () => {
    const { owner, student, project } = await scene();
    // owner 是 admin：建里程碑、改别人任务这类动作都归他
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const successor = await createTask(owner.id, project.id, { title: "答辩排练" });
    const milestone = await createMilestone(owner.id, project.id, { title: "中期答辩" });
    const tools = buildPersonalTools(owner.id);

    // 逐件产草案（入参与模型给的等价）；五件都在任何落库之前拟定，
    // 故 update_tasks 带的读时版本号仍是 task 当时的 updatedAt
    const envelopes = [
      await tools.create_milestone.execute!({ projectId: project.id, title: "终期答辩" }, opts),
      await tools.create_project.execute!({ teamId: project.teamId, name: "新项目" }, opts),
      await tools.decompose_tasks.execute!(
        { projectId: project.id, tasks: [{ title: "乙", assigneeId: student.id }] },
        opts,
      ),
      await tools.update_tasks.execute!(
        { projectId: project.id, updates: [{ taskId: task.id, patch: { assigneeId: student.id } }] },
        opts,
      ),
      await tools.edit_task_links.execute!(
        { projectId: project.id, predecessorId: task.id, add: [successor.id] },
        opts,
      ),
      await tools.plan_sprint.execute!(
        { projectId: project.id, milestoneId: milestone.id, taskIds: [task.id], dueDate: "2026-11-01" },
        opts,
      ),
    ];

    for (const env of envelopes) {
      const { tool, draft } = env as { tool: CommitToolName; draft: Record<string, unknown> };
      // 落库口要的那个 id：改项目的四件取 projectId，create_project 取 teamId
      expect(Object.keys(draft), `${tool} 的草案没带落库口要的 id`).toContain(
        tool === "create_project" ? "teamId" : "projectId",
      );
      // 原样交给个人落库口 —— 少了上面那个 id，这里正是那句「草案格式无效」
      const result = await commitPersonalDraft(owner.id, tool, draft);
      expect(result.committed, `${tool} 一条都没落`).toBeGreaterThan(0);
      expect(result.conflicts, `${tool} 不该有版本冲突`).toEqual([]);
    }

    // 落库真的生效了（不是「没报错但什么也没发生」）
    expect((await listProjectTasks(owner.id, project.id)).find((t) => t.id === task.id)).toMatchObject({
      assigneeId: student.id,
      milestoneId: milestone.id,
      dueDate: "2026-11-01",
    });
  });

  it("转派任务：工作台助手拟的 update_tasks 草案确认即可落库", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const tools = buildPersonalTools(owner.id);

    const env = (await tools.update_tasks.execute!(
      {
        projectId: project.id,
        updates: [{ taskId: task.id, patch: { assigneeId: student.id } }],
      },
      opts,
    )) as { draft: { projectId: string; updates: { updatedAt: string }[] } };

    expect(env.draft.projectId).toBe(project.id);
    expect(env.draft.updates[0].updatedAt).toBe(task.updatedAt.toISOString());
    await expect(commitPersonalDraft(owner.id, "update_tasks", env.draft)).resolves.toEqual({
      committed: 1,
      conflicts: [],
    });
    expect((await listProjectTasks(owner.id, project.id))[0]).toMatchObject({
      id: task.id,
      assigneeId: student.id,
    });
  });
});

// 右侧助手在项目页里会带一个「焦点项目」：不改会话归属，只多放出 6 件项目专属工具。
// 这里钉住工具面——多放一件或少放一件都会改变模型的选择空间（39 → 45 已是有意为之）。
describe("buildPersonalTools：焦点项目的工具面", () => {
  beforeEach(resetDb);

  it("恰好多出 6 件项目专属工具，基础工具面原样不动", async () => {
    const { student, project } = await scene();
    const base = buildPersonalTools(student.id);
    const focused = buildPersonalTools(student.id, project.id);

    expect(Object.keys(base)).toHaveLength(39);
    expect(Object.keys(focused)).toHaveLength(45);
    expect(Object.keys(focused).filter((name) => !(name in base)).sort()).toEqual(
      [...FOCUS_PROJECT_TOOL_NAMES].sort(),
    );
    // 同名的读工具仍是个人版（显式 projectId），没被项目版 schema 换掉 ——
    // 两版的描述文案不同（「指定项目」vs「该项目」），拿它当 discriminator
    expect(focused.query_progress.description).toBe(base.query_progress.description);
    expect(focused.list_tasks.description).toBe(base.list_tasks.description);
    expect(focused.get_task_detail.description).toBe(base.get_task_detail.description);
  });

  it("焦点版 create_subtask 草案自带焦点 projectId，确认后落库", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "写开题报告" });
    const tools = buildPersonalTools(student.id, project.id);

    const env = (await tools.create_subtask.execute!(
      { parentTaskId: parent.id, title: "查文献", priority: "high" as const },
      opts,
    )) as { __draft: true; tool: string; draft: Record<string, unknown> };
    expect(env).toMatchObject({
      __draft: true,
      tool: "create_subtask",
      draft: {
        projectId: project.id,
        parentTaskId: parent.id,
        parentTitle: "写开题报告",
        title: "查文献",
        priority: "high",
      },
    });
    // 草案就是草案
    expect(await listSubtasks(student.id, parent.id)).toEqual([]);

    // 个人落库口无需改动：projectId 就在草案里
    await expect(commitPersonalDraft(student.id, "create_subtask", env.draft)).resolves.toEqual({
      committed: 1,
      conflicts: [],
    });
    expect((await listSubtasks(student.id, parent.id)).map((s) => s.title)).toEqual(["查文献"]);
  });

  it("焦点版 delete_subtask / delete_attachment 草案经个人落库口生效", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父任务" });
    const child = await createSubtask(owner.id, parent.id, { title: "子任务" });
    const data = Buffer.from("附件正文");
    const att = await uploadAttachment(owner.id, parent.id, {
      filename: "报告.pdf",
      size: data.length,
      data,
    });
    const tools = buildPersonalTools(student.id, project.id);

    const delSub = (await tools.delete_subtask.execute!({ taskId: child.id }, opts)) as {
      draft: Record<string, unknown>;
    };
    expect(delSub.draft).toMatchObject({ projectId: project.id, taskId: child.id });
    await commitPersonalDraft(student.id, "delete_subtask", delSub.draft);
    expect(await listSubtasks(student.id, parent.id)).toEqual([]);

    const delAtt = (await tools.delete_attachment.execute!({ attachmentId: att.id }, opts)) as {
      draft: Record<string, unknown>;
    };
    expect(delAtt.draft).toMatchObject({ projectId: project.id, attachmentId: att.id });
    await commitPersonalDraft(student.id, "delete_attachment", delAtt.draft);
    expect(await listAttachments(student.id, parent.id)).toEqual([]);
  });

  it("焦点钉死在构造时的项目：别处的父任务与附件都过不去", async () => {
    const { owner, student, project } = await scene();
    // 同队的另一个项目：student 有访问权，故拒绝的理由只能是「不属于本项目」而非权限
    const otherInTeam = await createProject(owner.id, project.teamId, { name: "同队另一个项目" });
    const foreign = await createTask(owner.id, otherInTeam.id, { title: "别处的任务" });
    const data = Buffer.from("别处附件");
    const foreignAtt = await uploadAttachment(owner.id, foreign.id, {
      filename: "别处.txt",
      size: data.length,
      data,
    });
    const tools = buildPersonalTools(student.id, project.id);

    await expect(
      tools.create_subtask.execute!({ parentTaskId: foreign.id, title: "越界子任务" }, opts),
    ).rejects.toThrow("任务不属于该项目");
    await expect(
      tools.delete_attachment.execute!({ attachmentId: foreignAtt.id }, opts),
    ).rejects.toThrow("附件不属于该项目");
  });
});
