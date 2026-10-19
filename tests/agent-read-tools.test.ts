import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask, updateTask } from "@/lib/task";
import { createTaskComment } from "@/lib/comment";
import { countUnread, sendDm } from "@/lib/dm";
import {
  createGroup,
  inviteToGroup,
  listMyGroupInvites,
  sendGroupMessage,
} from "@/lib/group-chat";
import { commitPersonalDraft } from "@/lib/agent/commit";
import {
  buildPersonalTools,
  buildTools,
  RESPOND_INVITE_TOOL,
} from "@/lib/agent/tools";
import {
  getOrCreateConversation,
  getOrCreatePersonalConversation,
  persistTurn,
} from "@/lib/agent/conversation";
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
  // 外人的项目：student 一点边都不沾
  const otherTeam = await createTeam(outsider.id, "别人家的队伍");
  const otherProject = await createProject(outsider.id, otherTeam.id, { name: "机密项目" });
  return { owner, team, student, outsider, project, otherProject };
}

// AI SDK 的 tool.execute 签名为 (input, options)；测试直调传占位 options
const opts = {} as never;

type ActivityRow = {
  at: string;
  actor: string;
  taskId: string;
  taskTitle: string;
  projectName?: string;
  action: string;
  field: string | null;
  from: string | null;
  to: string | null;
};

describe("项目助手的读工具（动态 / 留言 / 更早对话）", () => {
  beforeEach(resetDb);

  it("list_project_activity：最新在前、动作中文化，可按任务过滤", async () => {
    const { student, owner, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    await updateTask(owner.id, task.id, { status: "doing" });
    const other = await createTask(owner.id, project.id, { title: "答辩排练" });

    const tools = buildTools(student.id, project.id);
    const rows = (await tools.list_project_activity.execute!({}, opts)) as ActivityRow[];

    // 最新在前：最后建的「答辩排练」排第一
    expect(rows[0]).toMatchObject({ taskId: other.id, taskTitle: "答辩排练", action: "创建任务" });
    expect(rows.find((r) => r.action === "创建任务" && r.taskId === task.id)).toMatchObject({
      actor: "owner",
      taskTitle: "写开题报告",
    });
    const changed = rows.find((r) => r.action === "修改字段")!;
    expect(changed).toMatchObject({
      actor: "owner",
      taskId: task.id,
      taskTitle: "写开题报告",
      field: "状态",
      from: "待办",
      to: "进行中",
    });
    expect(typeof changed.at).toBe("string");

    // 只看一个任务
    const only = (await tools.list_project_activity.execute!(
      { taskId: other.id },
      opts,
    )) as ActivityRow[];
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((r) => r.taskId === other.id)).toBe(true);

    // 拿不存在的 taskId 追问：如实报错，不返回空列表假装「没有动态」
    await expect(
      tools.list_project_activity.execute!(
        { taskId: "00000000-0000-0000-0000-000000000000" },
        opts,
      ),
    ).rejects.toThrow("任务不存在");
  });

  it("list_comments：跨任务汇总、可按任务过滤，作者与标题齐全", async () => {
    const { student, owner, project } = await scene();
    const t1 = await createTask(owner.id, project.id, { title: "任务一" });
    const t2 = await createTask(owner.id, project.id, { title: "任务二" });
    await createTaskComment(owner.id, t1.id, "第一个任务的留言");
    await createTaskComment(student.id, t2.id, "第二个任务的留言");

    const tools = buildTools(student.id, project.id);
    const rows = (await tools.list_comments.execute!({}, opts)) as {
      taskId: string;
      taskTitle: string;
      author: string;
      content: string;
    }[];
    expect(rows.map((r) => r.content).sort()).toEqual(["第一个任务的留言", "第二个任务的留言"]);
    expect(rows.find((r) => r.taskId === t2.id)).toMatchObject({
      taskTitle: "任务二",
      author: "student",
    });

    const only = (await tools.list_comments.execute!({ taskId: t1.id }, opts)) as {
      taskId: string;
    }[];
    expect(only.map((r) => r.taskId)).toEqual([t1.id]);
  });

  it("list_chat_history：只读本项目会话，正序带时间，不串个人会话", async () => {
    const { student, project } = await scene();
    const conv = await getOrCreateConversation(student.id, project.id);
    await persistTurn(conv.id, "第一问", "第一答", []);
    await persistTurn(conv.id, "第二问", "第二答", []);

    // 同一用户的个人会话：不该出现在项目历史里
    const personal = await getOrCreatePersonalConversation(student.id);
    await persistTurn(personal.id, "个人私聊", "个人答复", []);

    const tools = buildTools(student.id, project.id);
    const rows = (await tools.list_chat_history.execute!({}, opts)) as {
      at: string;
      role: string;
      content: string;
    }[];
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ["user", "第一问"],
      ["assistant", "第一答"],
      ["user", "第二问"],
      ["assistant", "第二答"],
    ]);
    expect(typeof rows[0].at).toBe("string");
    expect(JSON.stringify(rows)).not.toContain("个人私聊");

    // 非成员：项目会话创建本身就被拒
    const stranger = await makeUser("stranger@example.com");
    const strangerTools = buildTools(stranger.id, project.id);
    await expect(strangerTools.list_chat_history.execute!({}, opts)).rejects.toThrow("没有权限");
  });
});

describe("工作台助手的读工具（消息 / 群邀请 / 任务动态）", () => {
  beforeEach(resetDb);

  it("list_message_threads：私信、群聊、邀请与未读计数一次给全", async () => {
    const { owner, student } = await scene();
    await sendDm(owner.id, student.id, { content: "在吗，帮我看下任务" });
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    await sendGroupMessage(owner.id, group.id, { content: "下午开会" });
    const invited = await createGroup(owner.id, "另一个群", []);
    await inviteToGroup(owner.id, invited.id, "student");

    const tools = buildPersonalTools(student.id);
    const out = (await tools.list_message_threads.execute!(opts, opts)) as {
      unread: { directMessages: number; groups: number; groupInvites: number };
      directMessages: { peerId: string; peerName: string; unread: number; preview: string }[];
      groups: { groupId: string; name: string; preview: string; lastSenderName: string }[];
      invites: { inviteId: string; groupId: string; groupName: string; inviterName: string }[];
    };

    expect(out.unread).toEqual({ directMessages: 1, groups: 1, groupInvites: 1 });
    expect(out.directMessages[0]).toMatchObject({
      peerId: owner.id,
      peerName: "owner",
      unread: 1,
      preview: "在吗，帮我看下任务",
    });
    expect(out.groups[0]).toMatchObject({
      groupId: group.id,
      name: "讨论组",
      preview: "下午开会",
      lastSenderName: "owner",
    });
    expect(out.invites[0]).toMatchObject({
      groupId: invited.id,
      groupName: "另一个群",
      inviterName: "owner",
    });

    // 概览是只读的：未读原样
    expect(await countUnread(student.id)).toBe(1);
  });

  it("read_messages：私信与群聊二选一，且不标记已读", async () => {
    const { owner, student } = await scene();
    await sendDm(owner.id, student.id, { content: "私信正文" });
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    await sendGroupMessage(owner.id, group.id, { content: "群聊正文" });

    const tools = buildPersonalTools(student.id);
    const dm = (await tools.read_messages.execute!({ peerId: owner.id }, opts)) as {
      kind: string;
      peer: { id: string; name: string };
      messages: { content: string; mine: boolean }[];
      hasMore: boolean;
    };
    expect(dm.kind).toBe("dm");
    expect(dm.peer).toEqual({ id: owner.id, name: "owner" });
    expect(dm.messages.map((m) => [m.content, m.mine])).toEqual([["私信正文", false]]);
    expect(dm.hasMore).toBe(false);

    const g = (await tools.read_messages.execute!({ groupId: group.id }, opts)) as {
      kind: string;
      group: { id: string; name: string };
      messages: { content: string; senderName: string; mine: boolean }[];
    };
    expect(g.kind).toBe("group");
    expect(g.group.name).toBe("讨论组");
    expect(g.messages.map((m) => [m.content, m.senderName, m.mine])).toEqual([
      ["群聊正文", "owner", false],
    ]);

    // 助手看过不等于用户看过
    expect(await countUnread(student.id)).toBe(1);

    await expect(tools.read_messages.execute!({}, opts)).rejects.toThrow(
      "peerId 与 groupId 必须二选一",
    );
    await expect(
      tools.read_messages.execute!({ peerId: owner.id, groupId: group.id }, opts),
    ).rejects.toThrow("peerId 与 groupId 必须二选一");
  });

  it("list_my_task_activity：只含分配给我的任务，带项目名", async () => {
    const { owner, student, project } = await scene();
    const mine = await createTask(owner.id, project.id, {
      title: "我的活",
      assigneeId: student.id,
    });
    await updateTask(owner.id, mine.id, { status: "doing" });
    const others = await createTask(owner.id, project.id, { title: "别人的活" });
    await updateTask(owner.id, others.id, { status: "doing" });

    const tools = buildPersonalTools(student.id);
    const rows = (await tools.list_my_task_activity.execute!({}, opts)) as ActivityRow[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.taskId === mine.id)).toBe(true);
    expect(rows.every((r) => r.projectName === "赤壁演习")).toBe(true);
    expect(rows.some((r) => r.action === "修改字段" && r.to === "进行中")).toBe(true);
  });

  it("respond_group_invite：只产草案不动邀请；他人邀请被拒；确认后生效", async () => {
    const { owner, student, outsider } = await scene();
    const group = await createGroup(owner.id, "讨论组", []);
    await inviteToGroup(owner.id, group.id, "student");
    const [invite] = await listMyGroupInvites(student.id);

    const tools = buildPersonalTools(student.id);
    const env = (await tools.respond_group_invite.execute!(
      { inviteId: invite.inviteId, accept: true },
      opts,
    )) as { __draft: true; tool: string; draft: Record<string, unknown> };
    expect(env).toMatchObject({
      __draft: true,
      tool: RESPOND_INVITE_TOOL,
      draft: {
        inviteId: invite.inviteId,
        accept: true,
        groupId: group.id,
        groupName: "讨论组",
        inviterName: "owner",
      },
    });
    // 草案就是草案：邀请还在
    expect(await listMyGroupInvites(student.id)).toHaveLength(1);

    // 别人的邀请 id：拟稿阶段就拦下，别等到落库才炸
    await inviteToGroup(owner.id, group.id, "outsider");
    const [foreignInvite] = await listMyGroupInvites(outsider.id);
    await expect(
      tools.respond_group_invite.execute!({ inviteId: foreignInvite.inviteId, accept: true }, opts),
    ).rejects.toThrow("邀请不存在或已处理");

    // 确认落库：拒绝
    await expect(
      commitPersonalDraft(student.id, RESPOND_INVITE_TOOL, {
        inviteId: invite.inviteId,
        accept: false,
        groupName: "伪造的群名",
      }),
    ).resolves.toEqual({ committed: 1, conflicts: [] });
    expect(await listMyGroupInvites(student.id)).toEqual([]);
  });
});
