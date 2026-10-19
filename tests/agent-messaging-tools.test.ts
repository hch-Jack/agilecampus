import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { getAttachmentForDownload, uploadAttachment } from "@/lib/attachment";
import {
  getDmAttachmentForDownload,
  listConversations,
  listDmMessagesReadOnly,
  sendDm,
} from "@/lib/dm";
import {
  createGroup,
  getGroupInfo,
  listGroupConversations,
  listGroupMessagesReadOnly,
  listMyGroupInvites,
  respondToGroupInvite,
  sendGroupMessage,
} from "@/lib/group-chat";
import {
  buildPersonalTools,
  CREATE_GROUP_TOOL,
  FORWARD_MESSAGE_TOOL,
  INVITE_GROUP_TOOL,
  SEND_MESSAGE_TOOL,
} from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const third = await makeUser("third@example.com");
  await joinTeam(third.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  return { owner, team, student, third, outsider, project };
}

const opts = {} as never;

function envelope(out: unknown) {
  return out as { __draft: true; tool: string; draft: Record<string, unknown> };
}

function lastMessage(
  messages: {
    attachment: { id: string; filename: string; size: number } | null;
    content: string;
  }[],
) {
  return messages[messages.length - 1];
}

describe("工作台助手：寻找联系人", () => {
  beforeEach(resetDb);

  it("find_contact 按用户名精确命中，拒绝自己与不存在的人", async () => {
    const { owner, student } = await scene();
    const tools = buildPersonalTools(student.id);

    await expect(tools.find_contact.execute!({ username: "OWNER" }, opts)).resolves.toEqual({
      userId: owner.id,
      name: "owner",
    });
    await expect(
      tools.find_contact.execute!({ username: "nobody" }, opts),
    ).rejects.toThrow("用户不存在");
    await expect(
      tools.find_contact.execute!({ username: "student" }, opts),
    ).rejects.toThrow("这是你自己");
  });
});

describe("工作台助手：发送消息", () => {
  beforeEach(resetDb);

  it("私信草案不落库；确认后发送并出现在会话里", async () => {
    const { owner, student } = await scene();
    await sendDm(owner.id, student.id, { content: "在吗" });
    const tools = buildPersonalTools(student.id);

    const env = envelope(
      await tools.send_message.execute!(
        { targetType: "user" as const, targetId: owner.id, content: "  收到  " },
        opts,
      ),
    );
    expect(env).toMatchObject({
      __draft: true,
      tool: SEND_MESSAGE_TOOL,
      draft: {
        targetType: "user",
        targetId: owner.id,
        targetName: "owner",
        content: "收到",
      },
    });
    // 确认前只有对方发来的那一条
    const before = await listDmMessagesReadOnly(student.id, owner.id);
    expect(before.messages.map((m) => m.content)).toEqual(["在吗"]);

    await expect(
      commitPersonalDraft(student.id, SEND_MESSAGE_TOOL, env.draft),
    ).resolves.toEqual({ committed: 1, conflicts: [] });
    const after = await listDmMessagesReadOnly(student.id, owner.id);
    expect(after.messages.map((m) => [m.content, m.mine])).toEqual([
      ["在吗", false],
      ["收到", true],
    ]);
    // 双方会话行都补齐
    expect((await listConversations(owner.id)).map((c) => c.peerName)).toContain("student");
  });

  it("群消息草案不落库；确认后群成员都能读到", async () => {
    const { owner, student } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const tools = buildPersonalTools(student.id);

    const env = envelope(
      await tools.send_message.execute!(
        { targetType: "group" as const, targetId: group.id, content: "大家下午好" },
        opts,
      ),
    );
    expect(env.draft).toMatchObject({ targetName: "讨论组", content: "大家下午好" });
    expect((await listGroupMessagesReadOnly(student.id, group.id)).messages).toEqual([]);

    await commitPersonalDraft(student.id, SEND_MESSAGE_TOOL, env.draft);
    const after = await listGroupMessagesReadOnly(owner.id, group.id);
    expect(after.messages.map((m) => [m.content, m.senderName])).toEqual([
      ["大家下午好", "student"],
    ]);
  });

  it("非群成员不能发群消息；不能给自己发私信", async () => {
    const { owner, student, outsider } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const outsiderTools = buildPersonalTools(outsider.id);
    await expect(
      outsiderTools.send_message.execute!(
        { targetType: "group" as const, targetId: group.id, content: "混进来" },
        opts,
      ),
    ).rejects.toThrow("你已不在该群聊中");

    const tools = buildPersonalTools(student.id);
    await expect(
      tools.send_message.execute!(
        { targetType: "user" as const, targetId: student.id, content: "自言自语" },
        opts,
      ),
    ).rejects.toThrow("不能给自己发消息");
  });

  it("可把项目任务附件发给个人：确认后复制字节到消息附件", async () => {
    const { owner, student, outsider, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "交设计稿" });
    const data = Buffer.from("项目文件内容");
    const att = await uploadAttachment(owner.id, task.id, {
      filename: "设计稿.png",
      mimeType: "image/png",
      size: data.length,
      data,
    });
    const tools = buildPersonalTools(student.id);

    // 助手实际链路：先 list_attachments 取 attachmentId（get_task_detail 不含附件）
    const listed = (await tools.list_attachments.execute!({ taskId: task.id }, opts)) as {
      attachmentId: string;
      filename: string;
    }[];
    expect(listed).toEqual([
      expect.objectContaining({ attachmentId: att.id, filename: "设计稿.png" }),
    ]);
    // 无权项目里的任务：附件列表也拒绝
    await expect(
      buildPersonalTools(outsider.id).list_attachments.execute!({ taskId: task.id }, opts),
    ).rejects.toThrow("没有权限");

    const env = envelope(
      await tools.send_message.execute!(
        {
          targetType: "user" as const,
          targetId: owner.id,
          content: "文件给你",
          fileSource: "task" as const,
          attachmentId: listed[0].attachmentId,
        },
        opts,
      ),
    );
    expect(env.draft).toMatchObject({
      targetName: "owner",
      fileSource: "task",
      attachmentId: att.id,
      filename: "设计稿.png",
      size: data.length,
    });
    // 草案阶段不会产生消息附件
    expect((await listDmMessagesReadOnly(student.id, owner.id)).messages).toEqual([]);

    await commitPersonalDraft(student.id, SEND_MESSAGE_TOOL, env.draft);
    const messages = (await listDmMessagesReadOnly(student.id, owner.id)).messages;
    const sent = lastMessage(messages);
    expect(sent).toMatchObject({ content: "文件给你", mine: true });
    expect(sent.attachment?.filename).toBe("设计稿.png");

    const stored = await getDmAttachmentForDownload(owner.id, sent.attachment!.id);
    expect(Buffer.from(stored.data).equals(data)).toBe(true);
    // 任务附件仍在（发送是复制，不是移动）
    expect(await getAttachmentForDownload(owner.id, att.id)).toMatchObject({
      filename: "设计稿.png",
    });
  });

  it("可转发消息里的文件（fileSource=message）", async () => {
    const { owner, student } = await scene();
    const data = Buffer.from("聊天里的文件");
    await sendDm(owner.id, student.id, {
      content: "原文件",
      file: { filename: "资料.zip", mimeType: "application/zip", size: data.length, data },
    });
    const received = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0];
    const sourceAttachmentId = received.attachment!.id;

    const tools = buildPersonalTools(student.id);
    const env = envelope(
      await tools.send_message.execute!(
        {
          targetType: "user" as const,
          targetId: owner.id,
          content: "再把文件发你一遍",
          fileSource: "message" as const,
          attachmentId: sourceAttachmentId,
        },
        opts,
      ),
    );
    await commitPersonalDraft(student.id, SEND_MESSAGE_TOOL, env.draft);

    const messages = (await listDmMessagesReadOnly(student.id, owner.id)).messages;
    const sent = lastMessage(messages);
    expect(sent.attachment?.filename).toBe("资料.zip");
    expect(sent.attachment?.id).not.toBe(sourceAttachmentId); // 确实是新复制的一份
    const stored = await getDmAttachmentForDownload(owner.id, sent.attachment!.id);
    expect(Buffer.from(stored.data).equals(data)).toBe(true);
  });

  it("附件来源与附件 id 必须成对；空消息被拒", async () => {
    const { owner, student } = await scene();
    const tools = buildPersonalTools(student.id);
    await expect(
      tools.send_message.execute!(
        { targetType: "user" as const, targetId: owner.id, content: "只有来源", fileSource: "task" as const },
        opts,
      ),
    ).rejects.toThrow("fileSource 与 attachmentId 必须同时给出");
    await expect(
      tools.send_message.execute!(
        { targetType: "user" as const, targetId: owner.id, content: "   " },
        opts,
      ),
    ).rejects.toThrow("消息内容和附件至少要有一个");
  });
});

describe("工作台助手：转发消息", () => {
  beforeEach(resetDb);

  it("私信消息（含文件）原样转发到群聊；草案阶段不发送", async () => {
    const { owner, student } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const data = Buffer.from("转发附件字节");
    await sendDm(owner.id, student.id, {
      content: "原始消息",
      file: { filename: "原文件.pdf", mimeType: "application/pdf", size: data.length, data },
    });
    const source = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0];

    const tools = buildPersonalTools(student.id);
    const env = envelope(
      await tools.forward_message.execute!(
        {
          sourceType: "dm" as const,
          sourceId: owner.id,
          messageId: source.id,
          targetType: "group" as const,
          targetId: group.id,
        },
        opts,
      ),
    );
    expect(env).toMatchObject({
      __draft: true,
      tool: FORWARD_MESSAGE_TOOL,
      draft: {
        sourceLabel: "与 owner 的私信",
        sourceSenderName: "owner",
        content: "原始消息",
        filename: "原文件.pdf",
        targetName: "讨论组",
      },
    });
    expect((await listGroupMessagesReadOnly(student.id, group.id)).messages).toEqual([]);

    await commitPersonalDraft(student.id, FORWARD_MESSAGE_TOOL, env.draft);
    const forwarded = lastMessage((await listGroupMessagesReadOnly(owner.id, group.id)).messages);
    expect(forwarded).toMatchObject({ content: "原始消息", senderName: "student" });
    expect(forwarded.attachment?.filename).toBe("原文件.pdf");
    const stored = await getDmAttachmentForDownload(owner.id, forwarded.attachment!.id);
    expect(Buffer.from(stored.data).equals(data)).toBe(true);
  });

  it("群消息可转发到私信；源消息不属于该会话时被拒", async () => {
    const { owner, student, third } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    await sendGroupMessage(owner.id, group.id, { content: "群里的话" });
    const source = (await listGroupMessagesReadOnly(student.id, group.id)).messages[0];

    const tools = buildPersonalTools(student.id);
    await expect(
      tools.forward_message.execute!(
        {
          sourceType: "dm" as const,
          sourceId: third.id,
          messageId: source.id,
          targetType: "user" as const,
          targetId: third.id,
        },
        opts,
      ),
    ).rejects.toThrow("消息不存在");

    const env = envelope(
      await tools.forward_message.execute!(
        {
          sourceType: "group" as const,
          sourceId: group.id,
          messageId: source.id,
          targetType: "user" as const,
          targetId: third.id,
        },
        opts,
      ),
    );
    expect(env.draft).toMatchObject({
      sourceLabel: "群聊「讨论组」",
      targetName: "third",
      content: "群里的话",
    });

    await commitPersonalDraft(student.id, FORWARD_MESSAGE_TOOL, env.draft);
    expect((await listDmMessagesReadOnly(third.id, student.id)).messages[0].content).toBe(
      "群里的话",
    );
  });

  it("外人不能转发别人的私信", async () => {
    const { owner, student, outsider } = await scene();
    await sendDm(owner.id, student.id, { content: "只给学生的" });
    const source = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0];

    const outsiderTools = buildPersonalTools(outsider.id);
    await expect(
      outsiderTools.forward_message.execute!(
        {
          sourceType: "dm" as const,
          sourceId: owner.id,
          messageId: source.id,
          targetType: "user" as const,
          targetId: owner.id,
        },
        opts,
      ),
    ).rejects.toThrow("没有权限");
  });
});

describe("工作台助手：组建群聊", () => {
  beforeEach(resetDb);

  it("草案不建群；确认后才创建并把成员直接拉入", async () => {
    const { student, owner, third } = await scene();
    const tools = buildPersonalTools(student.id);

    // 实际链路：find_contact 返回的 name 直接交给建群工具（不再誊抄 userId）
    const contact = (await tools.find_contact.execute!({ username: "THIRD" }, opts)) as {
      userId: string;
      name: string;
    };
    expect(contact).toMatchObject({ userId: third.id, name: "third" });

    const env = envelope(
      await tools.create_group_chat.execute!(
        { name: "  新讨论组  ", usernames: ["owner", contact.name] },
        opts,
      ),
    );
    expect(env).toMatchObject({
      __draft: true,
      tool: CREATE_GROUP_TOOL,
      draft: {
        name: "新讨论组",
        usernames: ["owner", "third"],
        memberIds: [owner.id, third.id],
        memberCount: 3,
      },
    });
    expect(env.draft.members).toEqual(
      expect.arrayContaining([
        { id: owner.id, name: "owner" },
        { id: third.id, name: "third" },
      ]),
    );
    expect(await listGroupConversations(student.id)).toEqual([]);

    await commitPersonalDraft(student.id, CREATE_GROUP_TOOL, env.draft);
    const groups = await listGroupConversations(student.id);
    expect(groups.map((g) => [g.name, g.memberCount])).toEqual([["新讨论组", 3]]);
    const info = await getGroupInfo(owner.id, groups[0].groupId);
    expect(info.members.map((m) => m.name).sort()).toEqual(["owner", "student", "third"]);
  });

  it("只有自己也能建群：usernames 留空或只写自己都行，确认后 memberCount=1", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    // 省略 usernames
    const solo = envelope(await tools.create_group_chat.execute!({ name: "单人房" }, opts));
    expect(solo.draft).toMatchObject({ memberCount: 1, memberIds: [], members: [] });

    // 名单里写了自己：被忽略，而不是报错
    const selfNamed = envelope(
      await tools.create_group_chat.execute!({ name: "我也是", usernames: ["student"] }, opts),
    );
    expect(selfNamed.draft).toMatchObject({ memberCount: 1, memberIds: [] });

    await commitPersonalDraft(student.id, CREATE_GROUP_TOOL, solo.draft);
    const groups = await listGroupConversations(student.id);
    expect(groups.map((g) => [g.name, g.memberCount])).toEqual([["单人房", 1]]);
  });

  it("用户名不存在 / 缺群名被拒", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);
    await expect(
      tools.create_group_chat.execute!({ name: "幽灵群", usernames: ["nobody"] }, opts),
    ).rejects.toThrow("用户不存在：nobody");
    await expect(
      tools.create_group_chat.execute!({ name: "   " }, opts),
    ).rejects.toThrow("请输入群聊名称");
  });

  it("落库口允许只有自己的草案（与网页、REST 同口径）", async () => {
    const { student } = await scene();
    await expect(
      commitPersonalDraft(student.id, CREATE_GROUP_TOOL, {
        name: "单人房",
        memberIds: [student.id],
      }),
    ).resolves.toEqual({ committed: 1, conflicts: [] });
    const groups = await listGroupConversations(student.id);
    expect(groups.map((g) => [g.name, g.memberCount])).toEqual([["单人房", 1]]);
  });
});

describe("工作台助手：邀请进群", () => {
  beforeEach(resetDb);

  it("草案不落邀请；确认后生成待处理邀请，对方接受才入群", async () => {
    const { owner, student, third, outsider } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const tools = buildPersonalTools(owner.id);

    const env = envelope(
      await tools.invite_to_group.execute!(
        { groupId: group.id, usernames: ["third", "OUTSIDER"] },
        opts,
      ),
    );
    expect(env).toMatchObject({
      __draft: true,
      tool: INVITE_GROUP_TOOL,
      draft: {
        groupId: group.id,
        groupName: "讨论组",
        memberCount: 2,
        usernames: ["third", "outsider"],
      },
    });
    expect(env.draft.invitees).toEqual(
      expect.arrayContaining([
        { id: third.id, name: "third" },
        { id: outsider.id, name: "outsider" },
      ]),
    );
    // 确认前谁都没收到邀请
    expect(await listMyGroupInvites(third.id)).toEqual([]);
    expect(await listMyGroupInvites(outsider.id)).toEqual([]);
    expect((await getGroupInfo(owner.id, group.id)).memberCount).toBe(2);

    await expect(
      commitPersonalDraft(owner.id, INVITE_GROUP_TOOL, env.draft),
    ).resolves.toEqual({ committed: 1, conflicts: [] });

    const invites = await listMyGroupInvites(third.id);
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ groupId: group.id, groupName: "讨论组", inviterName: "owner" });
    expect(await listMyGroupInvites(outsider.id)).toHaveLength(1);
    // 接受前仍不是成员
    expect((await getGroupInfo(owner.id, group.id)).memberCount).toBe(2);

    await respondToGroupInvite(third.id, invites[0].inviteId, true);
    expect((await getGroupInfo(owner.id, group.id)).memberCount).toBe(3);
    expect(await listMyGroupInvites(third.id)).toEqual([]);
  });

  it("已在群 / 自己 / 查无此人 / 重复邀请 / 空用户名都被拒", async () => {
    const { owner, student } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const tools = buildPersonalTools(owner.id);

    await expect(
      tools.invite_to_group.execute!({ groupId: group.id, usernames: ["student"] }, opts),
    ).rejects.toThrow("TA 已在群聊里");
    await expect(
      tools.invite_to_group.execute!({ groupId: group.id, usernames: ["owner"] }, opts),
    ).rejects.toThrow("这是你自己");
    await expect(
      tools.invite_to_group.execute!({ groupId: group.id, usernames: ["ghost"] }, opts),
    ).rejects.toThrow("用户不存在");
    await expect(
      tools.invite_to_group.execute!({ groupId: group.id, usernames: ["  "] }, opts),
    ).rejects.toThrow("请输入要邀请的用户名");

    const env = envelope(
      await tools.invite_to_group.execute!(
        { groupId: group.id, usernames: ["third"] },
        opts,
      ),
    );
    await commitPersonalDraft(owner.id, INVITE_GROUP_TOOL, env.draft);
    await expect(
      tools.invite_to_group.execute!({ groupId: group.id, usernames: ["THIRD"] }, opts),
    ).rejects.toThrow("已邀请过，等待对方处理");
  });

  it("非群成员不能邀请；落库口重校群成员身份", async () => {
    const { owner, student, outsider, third } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);

    await expect(
      buildPersonalTools(outsider.id).invite_to_group.execute!(
        { groupId: group.id, usernames: ["third"] },
        opts,
      ),
    ).rejects.toThrow("你已不在该群聊中");

    await expect(
      commitPersonalDraft(outsider.id, INVITE_GROUP_TOOL, {
        groupId: group.id,
        usernames: ["third"],
      }),
    ).rejects.toThrow("你已不在该群聊中");
    expect(await listMyGroupInvites(third.id)).toEqual([]);
  });
});
