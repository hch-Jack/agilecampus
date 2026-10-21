import { describe, it, expect, beforeEach } from "vitest";
import {
  addContactByUsername,
  countUnread,
  findUserByUsername,
  getDmAttachmentForDownload,
  listConversations,
  listDmMessagesReadOnly,
  listMessages,
  sendDm,
} from "@/lib/dm";
import { createUser } from "@/lib/user";
import { ForbiddenError } from "@/lib/errors";
import { resetDb } from "./helpers";

async function seedUser(name: string, email: string) {
  const u = await createUser({ email, password: "password123", name });
  return { id: u.id, name: u.name };
}

describe("findUserByUsername / addContactByUsername", () => {
  beforeEach(resetDb);

  it("按用户名精准命中（不区分大小写）", async () => {
    const me = await seedUser("我", "me@example.com");
    const peer = await seedUser("ZhouYu", "zhou@example.com");
    const found = await findUserByUsername(me.id, "zhouyu");
    expect(found.id).toBe(peer.id);
    expect(found.name).toBe("ZhouYu");
  });

  it("用户名不存在 → 可展示错误（前端据此提示重新输入）", async () => {
    const me = await seedUser("我", "me@example.com");
    await expect(findUserByUsername(me.id, "不存在的人")).rejects.toThrow("用户不存在");
  });

  it("搜到自己 → 可展示错误", async () => {
    const me = await seedUser("我", "me@example.com");
    await expect(findUserByUsername(me.id, "我")).rejects.toThrow("这是你自己");
  });

  it("添加成功后进入我的消息列表", async () => {
    const me = await seedUser("我", "me@example.com");
    const peer = await seedUser("周瑜", "zhou@example.com");
    const added = await addContactByUsername(me.id, "周瑜");
    expect(added.id).toBe(peer.id);
    const convs = await listConversations(me.id);
    expect(convs).toHaveLength(1);
    expect(convs[0].peerId).toBe(peer.id);
    expect(convs[0].preview).toBeNull(); // 还没说过话
  });

  it("重复添加幂等，不产生第二条会话", async () => {
    const me = await seedUser("我", "me@example.com");
    await seedUser("周瑜", "zhou@example.com");
    await addContactByUsername(me.id, "周瑜");
    await addContactByUsername(me.id, "周瑜");
    expect(await listConversations(me.id)).toHaveLength(1);
  });
});

describe("sendDm / listMessages", () => {
  beforeEach(resetDb);

  it("发文本：双方都出现在彼此消息列表，未读数正确", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await sendDm(a.id, b.id, { content: "你好" });

    // 接收方从未添加过发送方，收消息自动进入其消息列表
    const convsB = await listConversations(b.id);
    expect(convsB.map((c) => c.peerId)).toContain(a.id);
    expect(convsB[0].preview).toBe("你好");
    expect(convsB[0].unread).toBe(1);
    expect(convsB[0].lastMine).toBe(false);

    const convsA = await listConversations(a.id);
    expect(convsA[0].preview).toBe("你好");
    expect(convsA[0].lastMine).toBe(true);
    expect(convsA[0].unread).toBe(0);
  });

  it("打开会话即已读：未读清零，对方回执可见", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await sendDm(a.id, b.id, { content: "在吗" });
    expect(await countUnread(b.id)).toBe(1);

    await listMessages(b.id, a.id);
    expect(await countUnread(b.id)).toBe(0);

    // 甲再次查看：自己发的消息已被乙读走
    const { messages } = await listMessages(a.id, b.id);
    expect(messages).toHaveLength(1);
    expect(messages[0].mine).toBe(true);
    expect(messages[0].readAt).not.toBeNull();
  });

  it("历史全量留存：收发的每条消息都在会话里", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await sendDm(a.id, b.id, { content: "第一条" });
    await sendDm(b.id, a.id, { content: "收到" });
    await sendDm(a.id, b.id, { content: "第二条" });

    const { messages } = await listMessages(a.id, b.id);
    expect(messages.map((m) => m.content)).toEqual(["第一条", "收到", "第二条"]);
    expect(messages.map((m) => m.mine)).toEqual([true, false, true]);
  });

  it("会话按最近消息倒序；预览为最近一条", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    const c = await seedUser("丙", "c@example.com");
    await sendDm(a.id, b.id, { content: "给乙" });
    await sendDm(a.id, c.id, { content: "给丙" });

    const convs = await listConversations(a.id);
    expect(convs.map((x) => x.peerName)).toEqual(["丙", "乙"]);

    // 乙回一条后跳到最前
    await sendDm(b.id, a.id, { content: "乙回了" });
    const convs2 = await listConversations(a.id);
    expect(convs2[0].peerName).toBe("乙");
    expect(convs2[0].preview).toBe("乙回了");
  });

  it("不能给自己发消息；对方不存在报错", async () => {
    const a = await seedUser("甲", "a@example.com");
    await expect(sendDm(a.id, a.id, { content: "自言自语" })).rejects.toThrow("不能给自己发消息");
    await expect(
      sendDm(a.id, "00000000-0000-0000-0000-000000000000", { content: "hi" }),
    ).rejects.toThrow("用户不存在");
  });

  it("纯空白内容且无附件 → 不能发送空消息", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await expect(sendDm(a.id, b.id, { content: "   " })).rejects.toThrow("不能发送空消息");
  });

  it("超长文本截断到 5000 字符", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await sendDm(a.id, b.id, { content: "长".repeat(6000) });
    const { messages } = await listMessages(a.id, b.id);
    expect(messages[0].content).toHaveLength(5000);
  });
});

// 助手读消息必须「看过不留痕」：用户没打开的会话，未读角标与联系人列表都不该因助手而变
describe("listDmMessagesReadOnly（助手只读）", () => {
  beforeEach(resetDb);

  it("不置已读、不建联系人，未读数原样留着", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await sendDm(a.id, b.id, { content: "找我一下" });
    expect(await countUnread(b.id)).toBe(1);
    expect(await listConversations(b.id)).toHaveLength(1);

    const thread = await listDmMessagesReadOnly(b.id, a.id);
    expect(thread.peer.name).toBe("甲");
    expect(thread.messages.map((m) => m.content)).toEqual(["找我一下"]);
    expect(thread.messages[0].mine).toBe(false);
    // 读完仍是未读
    expect(await countUnread(b.id)).toBe(1);

    // 没有消息时也不该凭空建出一条联系人
    const c = await seedUser("丙", "c@example.com");
    const empty = await listDmMessagesReadOnly(c.id, a.id);
    expect(empty.messages).toEqual([]);
    expect(await listConversations(c.id)).toEqual([]);

    // 对照：正常的打开会话仍然置读
    await listMessages(b.id, a.id);
    expect(await countUnread(b.id)).toBe(0);
  });

  it("只取最近 N 条并给 hasMore，顺序仍按时间正序", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    for (const t of ["第一", "第二", "第三"]) await sendDm(a.id, b.id, { content: t });

    const thread = await listDmMessagesReadOnly(b.id, a.id, 2);
    expect(thread.messages.map((m) => m.content)).toEqual(["第二", "第三"]);
    expect(thread.hasMore).toBe(true);

    const all = await listDmMessagesReadOnly(b.id, a.id, 10);
    expect(all.messages).toHaveLength(3);
    expect(all.hasMore).toBe(false);
  });

  it("对端不存在 → 可展示错误", async () => {
    const a = await seedUser("甲", "a@example.com");
    await expect(
      listDmMessagesReadOnly(a.id, "00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow("用户不存在");
  });
});

describe("私信附件", () => {
  beforeEach(resetDb);

  it("带文件发送：附件落库、消息引用，收发双方均可下载", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    const data = Buffer.from("hello 私信附件");
    await sendDm(a.id, b.id, {
      content: "",
      file: { filename: "报告.pdf", mimeType: "application/pdf", size: data.length, data },
    });

    const convsB = await listConversations(b.id);
    expect(convsB[0].preview).toBe("[文件] 报告.pdf");
    expect(convsB[0].unread).toBe(1);

    const { messages } = await listMessages(b.id, a.id);
    expect(messages[0].attachment).not.toBeNull();
    const attId = messages[0].attachment!.id;

    // 双方都可取回内容
    const got = await getDmAttachmentForDownload(b.id, attId);
    expect(got.filename).toBe("报告.pdf");
    expect(got.mimeType).toBe("application/pdf");
    expect(Buffer.from(got.data).equals(data)).toBe(true);
    const gotA = await getDmAttachmentForDownload(a.id, attId);
    expect(gotA.filename).toBe("报告.pdf");
  });

  it("陌生人不可下载他人私信附件", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    const stranger = await seedUser("路人", "s@example.com");
    const data = Buffer.from("机密");
    await sendDm(a.id, b.id, {
      content: "",
      file: { filename: "机密.txt", mimeType: "text/plain", size: data.length, data },
    });
    const { messages } = await listMessages(b.id, a.id);
    const attId = messages[0].attachment!.id;
    await expect(getDmAttachmentForDownload(stranger.id, attId)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("空文件 / 超限文件拒绝", async () => {
    const a = await seedUser("甲", "a@example.com");
    const b = await seedUser("乙", "b@example.com");
    await expect(
      sendDm(a.id, b.id, {
        content: "",
        file: { filename: "空.txt", mimeType: "text/plain", size: 0, data: Buffer.alloc(0) },
      }),
    ).rejects.toThrow("不能上传空文件");
    await expect(
      sendDm(a.id, b.id, {
        content: "",
        file: {
          filename: "大.bin",
          mimeType: null,
          size: 10 * 1024 * 1024 + 1,
          data: Buffer.alloc(1),
        },
      }),
    ).rejects.toThrow("文件不能超过 10MB");
  });
});
