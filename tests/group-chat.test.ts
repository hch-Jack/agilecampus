import { describe, it, expect, beforeEach } from "vitest";
import { countUnread, getDmAttachmentForDownload } from "@/lib/dm";
import {
  countGroupUnread,
  countPendingGroupInvites,
  createGroup,
  dissolveGroup,
  inviteToGroup,
  kickMember,
  leaveGroup,
  listGroupConversations,
  listMyGroupInvites,
  openGroupConversation,
  respondToGroupInvite,
  sendGroupMessage,
  GROUP_MEMBER_CAP,
} from "@/lib/group-chat";
import { createUser } from "@/lib/user";
import { ForbiddenError } from "@/lib/errors";
import { db } from "@/db";
import { dmGroupMembers, users } from "@/db/schema";
import { resetDb } from "./helpers";

async function seedUser(name: string, email: string) {
  const u = await createUser({ email, password: "password123", name });
  return { id: u.id, name: u.name };
}

// 建一个「甲群主 + 乙、丙」三人群，返回群 id 与三人信息
async function seedGroup() {
  const owner = await seedUser("甲", "a@example.com");
  const b = await seedUser("乙", "b@example.com");
  const c = await seedUser("丙", "c@example.com");
  const group = await createGroup(owner.id, "项目讨论组", [b.id, c.id]);
  return { owner, b, c, groupId: group.id, groupName: group.name };
}

describe("createGroup / getGroupInfo（经 openGroupConversation）", () => {
  beforeEach(resetDb);

  it("建群后成员都能在会话列表看到群，成员数与群主标记正确", async () => {
    const { owner, b, c, groupId } = await seedGroup();

    for (const member of [owner, b, c]) {
      const convs = await listGroupConversations(member.id);
      expect(convs).toHaveLength(1);
      expect(convs[0].groupId).toBe(groupId);
      expect(convs[0].name).toBe("项目讨论组");
      expect(convs[0].memberCount).toBe(3);
      expect(convs[0].preview).toBeNull(); // 还没人说话
      expect(convs[0].lastAt).toBeNull();
      expect(convs[0].unread).toBe(0);
    }

    const ownerView = await openGroupConversation(owner.id, groupId);
    expect(ownerView.group.ownerId).toBe(owner.id);
    expect(ownerView.group.amOwner).toBe(true);
    expect(ownerView.group.memberCount).toBe(3);
    // joinedAt 升序：群主排第一
    expect(ownerView.group.members.map((m) => m.userId)).toEqual([owner.id, b.id, c.id]);

    const bView = await openGroupConversation(b.id, groupId);
    expect(bView.group.amOwner).toBe(false);
  });

  it("群名校验：空名与超长名拒绝", async () => {
    const owner = await seedUser("甲", "a@example.com");
    await expect(createGroup(owner.id, "   ", [])).rejects.toThrow("请输入群聊名称");
    await expect(createGroup(owner.id, "群".repeat(31), [])).rejects.toThrow(
      "群名称不能超过 30 个字",
    );
  });

  it("memberIds 去重且剔除自己；不存在的成员报错", async () => {
    const owner = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    const group = await createGroup(owner.id, "测试群", [b.id, b.id, owner.id]);
    expect(group.memberCount).toBe(2); // 甲 + 乙（重复与自家 id 均被剔除）

    await expect(
      createGroup(owner.id, "坏群", ["00000000-0000-0000-0000-000000000000"]),
    ).rejects.toThrow("邀请的成员不存在");
  });

  it("群规模上限：满 50 人可建，超上限拒绝", async () => {
    const owner = await seedUser("甲", "a@example.com");
    // 一次批量插入 49 个成员用户，绕开 createUser 逐个 bcrypt 的开销
    const rows = Array.from({ length: GROUP_MEMBER_CAP - 1 }, (_, i) => ({
      email: `m${i}@example.com`,
      name: `成员${i}`,
      passwordHash: "x",
    }));
    const inserted = await db.insert(users).values(rows).returning({ id: users.id });
    const group = await createGroup(owner.id, "大群", inserted.map((u) => u.id));
    expect(group.memberCount).toBe(GROUP_MEMBER_CAP);

    const extra = await seedUser("丁", "extra@example.com");
    await expect(
      createGroup(owner.id, "更大群", [...inserted.map((u) => u.id), extra.id]),
    ).rejects.toThrow("群成员最多 50 人");
  });
});

describe("inviteToGroup / respondToGroupInvite", () => {
  beforeEach(resetDb);

  it("邀请落库，被邀请人可见；重复邀请拒绝", async () => {
    const { owner, groupId, groupName } = await seedGroup();
    const d = await seedUser("丁", "d@example.com");

    const r = await inviteToGroup(owner.id, groupId, "丁");
    expect(r.inviteeName).toBe("丁");

    const invites = await listMyGroupInvites(d.id);
    expect(invites).toHaveLength(1);
    expect(invites[0].groupId).toBe(groupId);
    expect(invites[0].groupName).toBe(groupName);
    expect(invites[0].inviterName).toBe("甲");
    expect(await countPendingGroupInvites(d.id)).toBe(1);

    await expect(inviteToGroup(owner.id, groupId, "丁")).rejects.toThrow(
      "已邀请过，等待对方处理",
    );
  });

  it("邀请已在群的成员 / 自己 / 不存在的用户 → 可展示错误", async () => {
    const { owner, groupId } = await seedGroup();
    await expect(inviteToGroup(owner.id, groupId, "乙")).rejects.toThrow("TA 已在群聊里");
    await expect(inviteToGroup(owner.id, groupId, "甲")).rejects.toThrow("这是你自己");
    await expect(inviteToGroup(owner.id, groupId, "不存在的人")).rejects.toThrow("用户不存在");
  });

  it("非成员不能邀请（ForbiddenError）", async () => {
    const { groupId } = await seedGroup();
    const outsider = await seedUser("路人", "s@example.com");
    await expect(inviteToGroup(outsider.id, groupId, "路人乙")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("接受邀请：进群、邀请消失、群出现在会话列表", async () => {
    const { owner, groupId } = await seedGroup();
    const d = await seedUser("丁", "d@example.com");
    await inviteToGroup(owner.id, groupId, "丁");

    const invites = await listMyGroupInvites(d.id);
    const r = await respondToGroupInvite(d.id, invites[0].inviteId, true);
    expect(r.groupId).toBe(groupId);

    expect(await listMyGroupInvites(d.id)).toHaveLength(0);
    const convs = await listGroupConversations(d.id);
    expect(convs.map((c) => c.groupId)).toContain(groupId);
    const view = await openGroupConversation(d.id, groupId);
    expect(view.group.memberCount).toBe(4);
  });

  it("拒绝邀请：不进群，之后可被重新邀请", async () => {
    const { owner, groupId } = await seedGroup();
    const d = await seedUser("丁", "d@example.com");
    await inviteToGroup(owner.id, groupId, "丁");
    const invites = await listMyGroupInvites(d.id);
    await respondToGroupInvite(d.id, invites[0].inviteId, false);

    expect(await listMyGroupInvites(d.id)).toHaveLength(0);
    expect(await listGroupConversations(d.id)).toHaveLength(0);

    // 拒绝后可再次邀请（行存在即待处理，拒绝即删行）
    await expect(inviteToGroup(owner.id, groupId, "丁")).resolves.toMatchObject({
      inviteeName: "丁",
    });
  });

  it("重复响应只成功一次；动他人邀请报错", async () => {
    const { owner, groupId } = await seedGroup();
    const d = await seedUser("丁", "d@example.com");
    const e = await seedUser("戊", "e@example.com");
    await inviteToGroup(owner.id, groupId, "丁");
    const invites = await listMyGroupInvites(d.id);

    await respondToGroupInvite(d.id, invites[0].inviteId, true);
    await expect(respondToGroupInvite(d.id, invites[0].inviteId, true)).rejects.toThrow(
      "邀请不存在或已处理",
    );
    await expect(respondToGroupInvite(e.id, invites[0].inviteId, true)).rejects.toThrow(
      "邀请不存在或已处理",
    );
  });

  it("处理期间群被填满：接受报错且邀请保留，仍可拒绝", async () => {
    const { owner, groupId } = await seedGroup();
    const d = await seedUser("丁", "d@example.com");
    await inviteToGroup(owner.id, groupId, "丁");

    // 把群直接填到 50 人（当前 3 人 + 47 个直插成员行；「接受前复查」才是被测点）
    const rows = Array.from({ length: GROUP_MEMBER_CAP - 3 }, (_, i) => ({
      email: `f${i}@example.com`,
      name: `路人${i}`,
      passwordHash: "x",
    }));
    const inserted = await db.insert(users).values(rows).returning({ id: users.id });
    await db
      .insert(dmGroupMembers)
      .values(inserted.map((u) => ({ groupId, userId: u.id })));

    const invites = await listMyGroupInvites(d.id);
    await expect(respondToGroupInvite(d.id, invites[0].inviteId, true)).rejects.toThrow(
      "群成员已满（上限 50 人）",
    );
    // 邀请还在（接受失败回滚认领），可以拒绝收尾
    expect(await listMyGroupInvites(d.id)).toHaveLength(1);
    await expect(respondToGroupInvite(d.id, invites[0].inviteId, false)).resolves.toMatchObject({
      groupId,
    });
  });
});

describe("sendGroupMessage / 未读", () => {
  beforeEach(resetDb);

  it("发文本：其他成员未读 +1，预览与发送人名正确；发送者自己不计未读", async () => {
    const { owner, b, groupId } = await seedGroup();
    await sendGroupMessage(owner.id, groupId, { content: "大家好" });

    const convsB = await listGroupConversations(b.id);
    expect(convsB[0].preview).toBe("大家好");
    expect(convsB[0].lastSenderName).toBe("甲");
    expect(convsB[0].lastMine).toBe(false);
    expect(convsB[0].unread).toBe(1);
    expect(await countGroupUnread(b.id)).toBe(1);

    const convsA = await listGroupConversations(owner.id);
    expect(convsA[0].lastMine).toBe(true);
    expect(convsA[0].unread).toBe(0);
  });

  it("非成员不能发言（ForbiddenError）", async () => {
    const { groupId } = await seedGroup();
    const outsider = await seedUser("路人", "s@example.com");
    await expect(sendGroupMessage(outsider.id, groupId, { content: "混进来了" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("空消息 / 空文件 / 超限文件拒绝；超长文本截断", async () => {
    const { owner, groupId } = await seedGroup();
    await expect(sendGroupMessage(owner.id, groupId, { content: "   " })).rejects.toThrow(
      "不能发送空消息",
    );
    await expect(
      sendGroupMessage(owner.id, groupId, {
        content: "",
        file: { filename: "空.txt", mimeType: "text/plain", size: 0, data: Buffer.alloc(0) },
      }),
    ).rejects.toThrow("不能上传空文件");
    await expect(
      sendGroupMessage(owner.id, groupId, {
        content: "",
        file: {
          filename: "大.bin",
          mimeType: null,
          size: 10 * 1024 * 1024 + 1,
          data: Buffer.alloc(1),
        },
      }),
    ).rejects.toThrow("文件不能超过 10MB");

    await sendGroupMessage(owner.id, groupId, { content: "长".repeat(6000) });
    const { messages } = await openGroupConversation(owner.id, groupId);
    expect(messages[0].content).toHaveLength(5000);
  });

  it("未读数学：自己发的永不计；打开后清零；新消息再计", async () => {
    const { owner, b, groupId } = await seedGroup();
    await sendGroupMessage(b.id, groupId, { content: "一" });
    await sendGroupMessage(b.id, groupId, { content: "二" });
    expect(await countGroupUnread(owner.id)).toBe(2);

    await openGroupConversation(owner.id, groupId);
    expect(await countGroupUnread(owner.id)).toBe(0);

    await sendGroupMessage(b.id, groupId, { content: "三" });
    expect(await countGroupUnread(owner.id)).toBe(1);
  });

  it("打开会话回全量正序消息（含发送人名），超过 200 条只回最近 200", async () => {
    const { owner, b, groupId } = await seedGroup();
    await sendGroupMessage(b.id, groupId, { content: "第一条" });
    await sendGroupMessage(owner.id, groupId, { content: "第二条" });

    const { messages } = await openGroupConversation(owner.id, groupId);
    expect(messages.map((m) => m.content)).toEqual(["第一条", "第二条"]);
    expect(messages[0].senderName).toBe("乙");
    expect(messages[0].mine).toBe(false);
    expect(messages[1].mine).toBe(true);

    for (let i = 0; i < 205; i++) {
      await sendGroupMessage(b.id, groupId, { content: `刷屏${i}` });
    }
    const { messages: capped } = await openGroupConversation(owner.id, groupId);
    expect(capped).toHaveLength(200);
    expect(capped[0].content).toBe("刷屏5"); // 205 条里的第 6 条起
    expect(capped[199].content).toBe("刷屏204");
  });
});

describe("leaveGroup / kickMember / dissolveGroup", () => {
  beforeEach(resetDb);

  it("成员退群：从成员与会话列表消失，他人历史保留", async () => {
    const { owner, b, groupId } = await seedGroup();
    await sendGroupMessage(owner.id, groupId, { content: "历史消息" });

    await leaveGroup(b.id, groupId);
    expect(await listGroupConversations(b.id)).toHaveLength(0);
    const view = await openGroupConversation(owner.id, groupId);
    expect(view.group.memberCount).toBe(2);
    expect(view.messages.map((m) => m.content)).toEqual(["历史消息"]); // 他人可见历史
  });

  it("群主不能退群；未入群者退群报错", async () => {
    const { owner, groupId } = await seedGroup();
    await expect(leaveGroup(owner.id, groupId)).rejects.toThrow("群主不能退群，如需退出请解散群聊");
    const outsider = await seedUser("路人", "s@example.com");
    await expect(leaveGroup(outsider.id, groupId)).rejects.toThrow("你已不在该群聊中");
  });

  it("踢人：仅群主可踢，不能踢群主，被踢者消息仍留存", async () => {
    const { owner, b, groupId } = await seedGroup();
    await sendGroupMessage(b.id, groupId, { content: "乙说的话" });

    const outsider = await seedUser("路人", "s@example.com");
    await expect(kickMember(outsider.id, groupId, b.id)).rejects.toThrow("只有群主才能移除成员");
    await expect(kickMember(owner.id, groupId, owner.id)).rejects.toThrow("不能移除群主");

    await kickMember(owner.id, groupId, b.id);
    const view = await openGroupConversation(owner.id, groupId);
    expect(view.group.memberCount).toBe(2);
    expect(view.messages.map((m) => m.content)).toContain("乙说的话");
    // 被踢者再看这个群：会话列表没了，直连打开也被拒
    expect(await listGroupConversations(b.id)).toHaveLength(0);
    await expect(openGroupConversation(b.id, groupId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("解散：行级联清理，成员/消息/邀请全空；非群主解散被拒", async () => {
    const { owner, b, groupId } = await seedGroup();
    const d = await seedUser("丁", "d@example.com");
    await sendGroupMessage(b.id, groupId, { content: "要消失的消息" });
    await inviteToGroup(owner.id, groupId, "丁");

    const outsider = await seedUser("路人", "s@example.com");
    await expect(dissolveGroup(outsider.id, groupId)).rejects.toThrow("只有群主才能解散群聊");

    await dissolveGroup(owner.id, groupId);
    for (const member of [owner, b]) {
      expect(await listGroupConversations(member.id)).toHaveLength(0);
    }
    expect(await listMyGroupInvites(d.id)).toHaveLength(0);
    expect(await countGroupUnread(b.id)).toBe(0);
    expect(await countPendingGroupInvites(d.id)).toBe(0);
    await expect(dissolveGroup(owner.id, groupId)).rejects.toThrow("群聊不存在或已解散");
  });

  it("被移出后群私聊未读不受影响（私信与群未读是两套）", async () => {
    const { owner, b, groupId } = await seedGroup();
    await kickMember(owner.id, groupId, b.id);
    expect(await countUnread(b.id)).toBe(0);
  });
});

describe("群附件与下载授权", () => {
  beforeEach(resetDb);

  it("群文件：每个成员都能下载到原字节，非成员被拒", async () => {
    const { owner, b, groupId } = await seedGroup();
    const data = Buffer.from("hello 群附件");
    await sendGroupMessage(owner.id, groupId, {
      content: "",
      file: { filename: "设计稿.png", mimeType: "image/png", size: data.length, data },
    });

    const convsB = await listGroupConversations(b.id);
    expect(convsB[0].preview).toBe("[文件] 设计稿.png");

    const { messages } = await openGroupConversation(b.id, groupId);
    const attId = messages[0].attachment!.id;

    const gotB = await getDmAttachmentForDownload(b.id, attId);
    expect(gotB.filename).toBe("设计稿.png");
    expect(Buffer.from(gotB.data).equals(data)).toBe(true);
    const gotA = await getDmAttachmentForDownload(owner.id, attId);
    expect(gotA.filename).toBe("设计稿.png");

    const outsider = await seedUser("路人", "s@example.com");
    await expect(getDmAttachmentForDownload(outsider.id, attId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("群附件被踢后不可再下载；未知附件报不存在", async () => {
    const { owner, b, groupId } = await seedGroup();
    const data = Buffer.from("机密");
    await sendGroupMessage(owner.id, groupId, {
      content: "",
      file: { filename: "机密.txt", mimeType: "text/plain", size: data.length, data },
    });
    const { messages } = await openGroupConversation(b.id, groupId);
    const attId = messages[0].attachment!.id;

    await kickMember(owner.id, groupId, b.id);
    await expect(getDmAttachmentForDownload(b.id, attId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      getDmAttachmentForDownload(owner.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("附件不存在");
  });
});

describe("群会话列表排序契约（合并私信在 action 层完成）", () => {
  beforeEach(resetDb);

  it("多群时按最近消息时间倒序；没消息的群垫底", async () => {
    const { owner, b, groupId } = await seedGroup();
    const other = await createGroup(owner.id, "另一个群", []);

    // 乙在第一个群说话后，它排在前；没消息的「另一个群」垫底
    await sendGroupMessage(b.id, groupId, { content: "群里冒个泡" });
    const convs = await listGroupConversations(owner.id);
    expect(convs.map((c) => c.groupId)).toEqual([groupId, other.id]);
    expect(convs[0].lastAt).not.toBeNull();
    expect(convs[0].unread).toBe(1);
    expect(convs[1].lastAt).toBeNull();
  });
});
