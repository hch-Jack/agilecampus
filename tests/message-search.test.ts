import { describe, it, expect, beforeEach } from "vitest";
import { createUser } from "@/lib/user";
import { countUnread, sendDm } from "@/lib/dm";
import {
  createGroup,
  listGroupMessagesReadOnly,
  sendGroupMessage,
} from "@/lib/group-chat";
import { getMessageJumpTarget, searchMessages } from "@/lib/message-search";
import { resolveMessageNavigation } from "@/lib/agent/navigation";
import { buildPersonalTools } from "@/lib/agent/tools";
import { resetDb } from "./helpers";

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const student = await makeUser("student@example.com");
  const outsider = await makeUser("outsider@example.com");

  const dm = await sendDm(owner.id, student.id, { content: "周五验收演示视频" });
  await sendDm(student.id, owner.id, { content: "视频我放到共享盘了" });
  // 与搜索无关的会话：用来验证不会串到别人的消息
  await sendDm(owner.id, outsider.id, { content: "另一个项目的视频素材" });

  const group = await createGroup(owner.id, "答辩小组", [student.id]);
  await sendGroupMessage(owner.id, group.id, { content: "演示视频记得带备份" });
  const thread = await listGroupMessagesReadOnly(owner.id, group.id);
  const groupMsg = thread.messages[thread.messages.length - 1];

  return { owner, student, outsider, dm, group, groupMsg };
}

const opts = {} as never;

describe("searchMessages", () => {
  beforeEach(resetDb);

  it("跨私信与群聊搜正文，带出会话、发送人与 messageId", async () => {
    const { owner, student, dm, group, groupMsg } = await scene();

    const hits = await searchMessages(student.id, "视频");
    expect(hits.map((h) => h.content).sort()).toEqual(
      ["周五验收演示视频", "演示视频记得带备份", "视频我放到共享盘了"].sort(),
    );
    // 最近的排最前（群消息最后发出）
    expect(hits[0].messageId).toBe(groupMsg.id);

    expect(hits[0]).toMatchObject({
      kind: "group",
      conversationId: group.id,
      conversationName: "答辩小组",
      senderId: owner.id,
      senderName: "owner",
      mine: false,
    });

    const dmHit = hits.find((h) => h.messageId === dm.id)!;
    expect(dmHit).toMatchObject({
      kind: "dm",
      conversationId: owner.id,
      conversationName: "owner",
      senderName: "owner",
      mine: false,
    });
    expect(hits.find((h) => h.content === "视频我放到共享盘了")?.mine).toBe(true);
  });

  it("只能搜到自己收发的私信与仍在的群", async () => {
    const { outsider } = await scene();
    const hits = await searchMessages(outsider.id, "视频");
    expect(hits.map((h) => h.content)).toEqual(["另一个项目的视频素材"]);

    // 完全不相关的人什么都搜不到
    const stranger = await makeUser("stranger@example.com");
    await expect(searchMessages(stranger.id, "视频")).resolves.toEqual([]);
  });

  it("关键词按字面量匹配，% 与 _ 不是通配符", async () => {
    const { owner, student } = await scene();
    await sendDm(owner.id, student.id, { content: "完成度 100% 了" });

    const percent = await searchMessages(student.id, "%");
    expect(percent.map((h) => h.content)).toEqual(["完成度 100% 了"]);

    const underscore = await searchMessages(student.id, "_");
    expect(underscore).toEqual([]);
  });

  it("空关键词与 limit 上限都被收口", async () => {
    const { student } = await scene();
    await expect(searchMessages(student.id, "   ")).resolves.toEqual([]);
    const one = await searchMessages(student.id, "视频", 1);
    expect(one).toHaveLength(1);
    const huge = await searchMessages(student.id, "视频", 999);
    expect(huge.length).toBeLessThanOrEqual(50);
  });
});

describe("getMessageJumpTarget / open_message", () => {
  beforeEach(resetDb);

  it("私信与群聊各返回可跳转的会话信息", async () => {
    const { owner, student, dm, group, groupMsg } = await scene();

    await expect(getMessageJumpTarget(student.id, dm.id)).resolves.toEqual({
      kind: "dm",
      conversationId: owner.id,
      conversationName: "owner",
      messageId: dm.id,
    });
    await expect(getMessageJumpTarget(student.id, groupMsg.id)).resolves.toEqual({
      kind: "group",
      conversationId: group.id,
      conversationName: "答辩小组",
      messageId: groupMsg.id,
    });
  });

  it("无权查看的消息报「不存在或无权查看」", async () => {
    const { dm } = await scene();
    const stranger = await makeUser("stranger@example.com");
    await expect(getMessageJumpTarget(stranger.id, dm.id)).rejects.toThrow("无权查看");
  });

  it("open_message 产出带 msg 参数的消息页深链", async () => {
    const { owner, student, dm, group, groupMsg } = await scene();
    const tools = buildPersonalTools(student.id);

    await expect(tools.open_message.execute!({ messageId: dm.id }, opts)).resolves.toMatchObject({
      __navigate: true,
      href: `/messages?dm=${owner.id}&msg=${dm.id}`,
    });
    await expect(
      tools.open_message.execute!({ messageId: groupMsg.id }, opts),
    ).resolves.toMatchObject({
      __navigate: true,
      href: `/messages?group=${group.id}&msg=${groupMsg.id}`,
    });

    // 直接调 navigation 结果一致（工具只是它的薄封装）
    await expect(resolveMessageNavigation(student.id, dm.id)).resolves.toMatchObject({
      label: "与 owner 的对话",
    });
  });

  it("search_messages 工具只读：不标记已读", async () => {
    const { owner } = await scene();
    const before = await countUnread(owner.id);
    const tools = buildPersonalTools(owner.id);

    const out = (await tools.search_messages.execute!({ query: "视频" }, opts)) as {
      hits: { messageId: string }[];
    };
    expect(out.hits.length).toBeGreaterThan(0);
    await expect(countUnread(owner.id)).resolves.toBe(before);
  });
});
