import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { uploadAttachment, listAttachments } from "@/lib/attachment";
import { createApiToken } from "@/lib/api-token";
import {
  countUnread,
  getDmAttachmentForDownload,
  listDmMessagesReadOnly,
  sendDm,
} from "@/lib/dm";
import {
  createGroup,
  getGroupInfo,
  listGroupMessagesReadOnly,
  listMyGroupInvites,
  sendGroupMessage,
} from "@/lib/group-chat";
import { GET as contactsRoute } from "@/app/api/agent/contacts/route";
import { GET as messagesRoute, POST as sendMessageRoute } from "@/app/api/agent/messages/route";
import { GET as groupsRoute, POST as createGroupRoute } from "@/app/api/agent/groups/route";
import { POST as inviteRoute } from "@/app/api/agent/groups/[groupId]/invites/route";
import { POST as forwardRoute } from "@/app/api/agent/messages/forward/route";
import { GET as listTaskAttachmentsRoute } from "@/app/api/agent/tasks/[taskId]/attachments/route";
import {
  DELETE as deleteAttachmentRoute,
  GET as downloadAttachmentRoute,
} from "@/app/api/agent/attachments/[attachmentId]/route";
import { GET as downloadMessageAttachmentRoute } from "@/app/api/agent/message-attachments/[attachmentId]/route";
import { DELETE as deleteSubtaskRoute } from "@/app/api/agent/tasks/[taskId]/subtasks/[subtaskId]/route";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

function get(url: string, token?: string) {
  return new Request(`http://test${url}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function post(body: unknown, token?: string) {
  return new Request("http://test/api/agent", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function del(token?: string) {
  return new Request("http://test/api/agent", {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const attachmentCtx = (attachmentId: string) => ({
  params: Promise.resolve({ attachmentId }),
});
const taskCtx = (taskId: string) => ({ params: Promise.resolve({ taskId }) });
const groupCtx = (groupId: string) => ({ params: Promise.resolve({ groupId }) });
const subtaskCtx = (taskId: string, subtaskId: string) => ({
  params: Promise.resolve({ taskId, subtaskId }),
});

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  const ownerToken = (await createApiToken(owner.id, "owner 令牌")).token;
  const studentToken = (await createApiToken(student.id, "student 令牌")).token;
  const outsiderToken = (await createApiToken(outsider.id, "outsider 令牌")).token;
  return {
    owner,
    student,
    outsider,
    team,
    project,
    ownerToken,
    studentToken,
    outsiderToken,
  };
}

describe("GET /api/agent/contacts", () => {
  beforeEach(resetDb);

  it("列私信联系人；?username= 精确查人", async () => {
    const { owner, student, ownerToken } = await scene();
    await sendDm(owner.id, student.id, { content: "在吗" });

    const list = await contactsRoute(get("/api/agent/contacts", ownerToken));
    expect(list.status).toBe(200);
    const body = await list.json();
    expect(body.contacts).toHaveLength(1);
    expect(body.contacts[0]).toMatchObject({ peerId: student.id, name: "student" });

    const found = await contactsRoute(
      get("/api/agent/contacts?username=STUDENT", ownerToken),
    );
    expect(found.status).toBe(200);
    expect((await found.json()).user).toEqual({ id: student.id, name: "student" });
  });

  it("查无此人 / 查自己 / 空用户名 / 未登录", async () => {
    const { ownerToken } = await scene();
    expect(
      (await contactsRoute(get("/api/agent/contacts?username=ghost", ownerToken))).status,
    ).toBe(400);
    expect(
      (await contactsRoute(get("/api/agent/contacts?username=owner", ownerToken))).status,
    ).toBe(400);
    expect((await contactsRoute(get("/api/agent/contacts?username=", ownerToken))).status).toBe(
      400,
    );
    expect((await contactsRoute(get("/api/agent/contacts"))).status).toBe(401);
  });
});

describe("GET /api/agent/messages", () => {
  beforeEach(resetDb);

  it("私信只读：返回消息但不标已读、不建联系人", async () => {
    const { owner, student, studentToken } = await scene();
    await sendDm(owner.id, student.id, { content: "未读消息" });
    expect(await countUnread(student.id)).toBe(1);

    const res = await messagesRoute(
      get(`/api/agent/messages?peerId=${owner.id}`, studentToken),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.kind).toBe("dm");
    expect(body.peer).toEqual({ id: owner.id, name: "owner" });
    expect(body.messages.map((m: { content: string; mine: boolean }) => [m.content, m.mine])).toEqual([
      ["未读消息", false],
    ]);
    expect(await countUnread(student.id)).toBe(1);
  });

  it("群消息只读；非成员 403", async () => {
    const { owner, student, outsiderToken } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    await sendGroupMessage(owner.id, group.id, { content: "群消息" });

    const res = await messagesRoute(
      get(`/api/agent/messages?groupId=${group.id}`, outsiderToken),
    );
    expect(res.status).toBe(403);

    const ownerToken = (await createApiToken(owner.id, "第二个令牌")).token;
    const ok = await messagesRoute(get(`/api/agent/messages?groupId=${group.id}`, ownerToken));
    expect(ok.status).toBe(200);
    expect((await ok.json()).messages[0].content).toBe("群消息");
  });

  it("peerId / groupId 必须二选一；未登录 401", async () => {
    const { owner, studentToken } = await scene();
    const none = await messagesRoute(get("/api/agent/messages", studentToken));
    expect(none.status).toBe(400);
    const both = await messagesRoute(
      get(`/api/agent/messages?peerId=${owner.id}&groupId=${owner.id}`, studentToken),
    );
    expect(both.status).toBe(400);
    expect((await messagesRoute(get("/api/agent/messages"))).status).toBe(401);
  });
});

describe("POST /api/agent/messages", () => {
  beforeEach(resetDb);

  it("发私信与群消息", async () => {
    const { owner, student, studentToken } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);

    const dm = await sendMessageRoute(
      post({ toUserId: owner.id, content: " 你好 " }, studentToken),
    );
    expect(dm.status).toBe(200);
    expect(await dm.json()).toEqual({ sent: 1, targetType: "user", targetName: "owner" });
    expect(
      (await listDmMessagesReadOnly(student.id, owner.id)).messages.map((m) => m.content),
    ).toEqual(["你好"]);

    const gm = await sendMessageRoute(
      post({ toGroupId: group.id, content: "大家好" }, studentToken),
    );
    expect(gm.status).toBe(200);
    expect((await gm.json()).targetName).toBe("讨论组");
    expect((await listGroupMessagesReadOnly(owner.id, group.id)).messages[0].content).toBe(
      "大家好",
    );
  });

  it("可把任务附件作为消息文件发送", async () => {
    const { owner, student, project, studentToken } = await scene();
    const task = await createTask(owner.id, project.id, { title: "交设计稿" });
    const data = Buffer.from("任务附件字节");
    const att = await uploadAttachment(owner.id, task.id, {
      filename: "设计稿.png",
      mimeType: "image/png",
      size: data.length,
      data,
    });

    const res = await sendMessageRoute(
      post(
        {
          toUserId: owner.id,
          content: "项目文件给你",
          attachment: { source: "task", attachmentId: att.id },
        },
        studentToken,
      ),
    );
    expect(res.status).toBe(200);

    const sent = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0];
    expect(sent.content).toBe("项目文件给你");
    expect(sent.attachment?.filename).toBe("设计稿.png");
    const stored = await getDmAttachmentForDownload(owner.id, sent.attachment!.id);
    expect(Buffer.from(stored.data).equals(data)).toBe(true);
  });

  it("目标二选一、空消息、非群成员、未登录", async () => {
    const { owner, student, outsiderToken, studentToken } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);

    expect(
      (
        await sendMessageRoute(
          post({ toUserId: owner.id, toGroupId: group.id, content: "x" }, studentToken),
        )
      ).status,
    ).toBe(400);
    expect(
      (await sendMessageRoute(post({ toUserId: owner.id, content: "   " }, studentToken))).status,
    ).toBe(400);
    expect(
      (await sendMessageRoute(post({ toGroupId: group.id, content: "混进来" }, outsiderToken)))
        .status,
    ).toBe(403);
    expect(
      (await sendMessageRoute(post({ toUserId: owner.id, content: "x" }))).status,
    ).toBe(401);
  });
});

describe("GET/POST /api/agent/groups", () => {
  beforeEach(resetDb);

  it("建群后出现在我的群列表", async () => {
    const { owner, studentToken } = await scene();
    const created = await createGroupRoute(
      post({ name: "新讨论组", memberIds: [owner.id] }, studentToken),
    );
    expect(created.status).toBe(200);
    const group = await created.json();
    expect(group.name).toBe("新讨论组");
    expect(group.memberCount).toBe(2);
    expect(group.members.map((m: { name: string }) => m.name).sort()).toEqual(["owner", "student"]);

    const list = await groupsRoute(get("/api/agent/groups", studentToken));
    expect(list.status).toBe(200);
    expect((await list.json()).groups.map((g: { name: string }) => g.name)).toEqual([
      "新讨论组",
    ]);
  });

  it("成员不存在 / 缺群名 / 未登录被拒；只有自己可以建群", async () => {
    const { student, studentToken } = await scene();
    expect(
      (
        await createGroupRoute(
          post(
            { name: "幽灵群", memberIds: ["00000000-0000-4000-8000-000000000000"] },
            studentToken,
          ),
        )
      ).status,
    ).toBe(400);
    expect(
      (await createGroupRoute(post({ name: "  ", memberIds: [student.id] }, studentToken))).status,
    ).toBe(400);
    expect((await createGroupRoute(post({ name: "x", memberIds: [student.id] }))).status).toBe(
      401,
    );

    // memberIds 省略 = 只有自己；显式写自己也被过滤
    const solo = await createGroupRoute(post({ name: "单人房" }, studentToken));
    expect(solo.status).toBe(200);
    expect(await solo.json()).toMatchObject({ name: "单人房", memberCount: 1 });
    const selfOnly = await createGroupRoute(
      post({ name: "还是我", memberIds: [student.id] }, studentToken),
    );
    expect(selfOnly.status).toBe(200);
    expect(await selfOnly.json()).toMatchObject({ name: "还是我", memberCount: 1 });
  });
});

describe("POST /api/agent/groups/:groupId/invites", () => {
  beforeEach(resetDb);

  it("邀请单个/多个用户名进入待处理列表（不直接入群）", async () => {
    const { owner, student, outsider, ownerToken } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const newbie = await makeUser("newbie@example.com");

    const multi = await inviteRoute(
      post({ usernames: ["outsider", "newbie"] }, ownerToken),
      groupCtx(group.id),
    );
    expect(multi.status).toBe(200);
    expect(await multi.json()).toMatchObject({
      invited: 2,
      groupName: "讨论组",
      invitees: expect.arrayContaining([
        { userId: outsider.id, name: "outsider" },
        { userId: newbie.id, name: "newbie" },
      ]),
    });
    expect(await listMyGroupInvites(outsider.id)).toHaveLength(1);
    expect(await listMyGroupInvites(newbie.id)).toHaveLength(1);

    // 单人写法同样可用
    const another = await makeUser("another@example.com");
    const single = await inviteRoute(
      post({ username: "another" }, ownerToken),
      groupCtx(group.id),
    );
    expect(single.status).toBe(200);
    expect((await single.json()).invitees).toEqual([
      { userId: another.id, name: "another" },
    ]);

    // 待处理不算成员
    expect((await getGroupInfo(owner.id, group.id)).memberCount).toBe(2);
  });

  it("已在群 / 重复邀请 / 空参数 / 无效 id / 未登录 / 非成员", async () => {
    const { owner, student, ownerToken, outsiderToken } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);

    expect(
      (
        await inviteRoute(
          post({ usernames: ["student"] }, ownerToken),
          groupCtx(group.id),
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await inviteRoute(
          post({ usernames: ["outsider"] }, ownerToken),
          groupCtx(group.id),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await inviteRoute(
          post({ usernames: ["outsider"] }, ownerToken),
          groupCtx(group.id),
        )
      ).status,
    ).toBe(400);

    expect((await inviteRoute(post({}, ownerToken), groupCtx(group.id))).status).toBe(400);
    expect(
      (await inviteRoute(post({ usernames: ["outsider"] }, ownerToken), groupCtx("bad"))).status,
    ).toBe(400);
    expect(
      (await inviteRoute(post({ usernames: ["outsider"] }), groupCtx(group.id))).status,
    ).toBe(401);
    expect(
      (
        await inviteRoute(
          post({ usernames: ["student"] }, outsiderToken),
          groupCtx(group.id),
        )
      ).status,
    ).toBe(403);
  });
});

describe("POST /api/agent/messages/forward", () => {
  beforeEach(resetDb);

  it("私信消息原样转发到群聊（含附件字节复制）", async () => {
    const { owner, student, studentToken } = await scene();
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    const data = Buffer.from("转发源附件");
    await sendDm(owner.id, student.id, {
      content: "原始消息",
      file: { filename: "原文件.pdf", mimeType: "application/pdf", size: data.length, data },
    });
    const source = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0];

    const res = await forwardRoute(
      post(
        {
          sourceType: "dm",
          sourceId: owner.id,
          messageId: source.id,
          toGroupId: group.id,
        },
        studentToken,
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      forwarded: 1,
      sourceType: "dm",
      sourceLabel: "与 owner 的私信",
      targetType: "group",
      targetName: "讨论组",
    });

    const forwarded = (await listGroupMessagesReadOnly(owner.id, group.id)).messages[0];
    expect(forwarded).toMatchObject({ content: "原始消息", senderName: "student" });
    const stored = await getDmAttachmentForDownload(owner.id, forwarded.attachment!.id);
    expect(Buffer.from(stored.data).equals(data)).toBe(true);
  });

  it("非参与者 403；来源会话对不上 400；目标二选一", async () => {
    const { owner, student, outsiderToken, studentToken } = await scene();
    await sendDm(owner.id, student.id, { content: "只给学生" });
    const source = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0];

    expect(
      (
        await forwardRoute(
          post(
            {
              sourceType: "dm",
              sourceId: owner.id,
              messageId: source.id,
              toUserId: owner.id,
            },
            outsiderToken,
          ),
        )
      ).status,
    ).toBe(403);

    expect(
      (
        await forwardRoute(
          post(
            {
              sourceType: "dm",
              sourceId: "00000000-0000-4000-8000-000000000000",
              messageId: source.id,
              toUserId: owner.id,
            },
            studentToken,
          ),
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await forwardRoute(
          post(
            { sourceType: "dm", sourceId: owner.id, messageId: source.id, toUserId: owner.id, toGroupId: owner.id },
            studentToken,
          ),
        )
      ).status,
    ).toBe(400);
  });
});

describe("任务附件 REST", () => {
  beforeEach(resetDb);

  it("列表 / 下载 / 删除", async () => {
    const { owner, project, ownerToken } = await scene();
    const task = await createTask(owner.id, project.id, { title: "交设计稿" });
    const data = Buffer.from("附件字节");
    const att = await uploadAttachment(owner.id, task.id, {
      filename: "设计稿.png",
      mimeType: "image/png",
      size: data.length,
      data,
    });

    const list = await listTaskAttachmentsRoute(
      get(`/api/agent/tasks/${task.id}/attachments`, ownerToken),
      taskCtx(task.id),
    );
    expect(list.status).toBe(200);
    expect((await list.json()).attachments[0]).toMatchObject({
      id: att.id,
      filename: "设计稿.png",
    });

    const download = await downloadAttachmentRoute(
      get(`/api/agent/attachments/${att.id}`, ownerToken),
      attachmentCtx(att.id),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(Buffer.from(await download.arrayBuffer()).equals(data)).toBe(true);

    const removed = await deleteAttachmentRoute(
      del(ownerToken),
      attachmentCtx(att.id),
    );
    expect(removed.status).toBe(200);
    expect(await listAttachments(owner.id, task.id)).toEqual([]);
  });

  it("非成员 403 / 无效 id / 未登录", async () => {
    const { owner, outsiderToken, project, ownerToken } = await scene();
    const task = await createTask(owner.id, project.id, { title: "交设计稿" });
    const att = await uploadAttachment(owner.id, task.id, {
      filename: "a.txt",
      mimeType: "text/plain",
      size: 1,
      data: Buffer.from("a"),
    });

    expect(
      (
        await downloadAttachmentRoute(
          get(`/api/agent/attachments/${att.id}`, outsiderToken),
          attachmentCtx(att.id),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await deleteAttachmentRoute(del(outsiderToken), attachmentCtx(att.id))
      ).status,
    ).toBe(403);
    expect(
      (
        await downloadAttachmentRoute(
          get("/api/agent/attachments/not-a-uuid", ownerToken),
          attachmentCtx("not-a-uuid"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await listTaskAttachmentsRoute(
          get(`/api/agent/tasks/${task.id}/attachments`),
          taskCtx(task.id),
        )
      ).status,
    ).toBe(401);
  });

  it("消息附件 Bearer 下载：参与者可下，旁人 403", async () => {
    const { owner, student, ownerToken, outsiderToken } = await scene();
    const data = Buffer.from("消息里的文件");
    await sendDm(owner.id, student.id, {
      content: "文件",
      file: { filename: "资料.zip", mimeType: "application/zip", size: data.length, data },
    });
    const attId = (await listDmMessagesReadOnly(student.id, owner.id)).messages[0].attachment!.id;

    const ok = await downloadMessageAttachmentRoute(
      get(`/api/agent/message-attachments/${attId}`, ownerToken),
      attachmentCtx(attId),
    );
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(data)).toBe(true);

    const denied = await downloadMessageAttachmentRoute(
      get(`/api/agent/message-attachments/${attId}`, outsiderToken),
      attachmentCtx(attId),
    );
    expect(denied.status).toBe(403);
  });
});

describe("DELETE /api/agent/tasks/:taskId/subtasks/:subtaskId", () => {
  beforeEach(resetDb);

  it("删除子任务；父任务对不上 / 非成员 / 未登录", async () => {
    const { owner, outsiderToken, project, ownerToken } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父任务" });
    const child = await createTask(owner.id, project.id, {
      title: "子任务",
      parentTaskId: parent.id,
    });
    const other = await createTask(owner.id, project.id, { title: "别的任务" });

    const wrong = await deleteSubtaskRoute(
      del(ownerToken),
      subtaskCtx(other.id, child.id),
    );
    expect(wrong.status).toBe(400);

    const denied = await deleteSubtaskRoute(
      del(outsiderToken),
      subtaskCtx(parent.id, child.id),
    );
    expect(denied.status).toBe(403);

    expect(
      (await deleteSubtaskRoute(del(), subtaskCtx(parent.id, child.id))).status,
    ).toBe(401);

    const ok = await deleteSubtaskRoute(del(ownerToken), subtaskCtx(parent.id, child.id));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ deleted: child.id, parentTaskId: parent.id });
  });
});
