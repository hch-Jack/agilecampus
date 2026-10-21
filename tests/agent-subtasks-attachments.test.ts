import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createSubtask, createTask, listSubtasks } from "@/lib/task";
import {
  getAttachmentForDownload,
  listAttachments,
  uploadAttachment,
} from "@/lib/attachment";
import { sendDm } from "@/lib/dm";
import { createGroup, sendGroupMessage } from "@/lib/group-chat";
import {
  ATTACH_MESSAGE_TOOL,
  buildPersonalTools,
  buildTools,
} from "@/lib/agent/tools";
import { commitDraft, commitPersonalDraft } from "@/lib/agent/commit";
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
  const otherProject = await createProject(owner.id, team.id, { name: "另一个项目" });
  return { owner, team, student, outsider, project, otherProject };
}

// AI SDK 的 tool.execute 签名为 (input, options)；测试直调传占位 options
const opts = {} as never;

function envelope(out: unknown) {
  return out as { __draft: true; tool: string; draft: Record<string, unknown> };
}

describe("项目助手：子任务操作", () => {
  beforeEach(resetDb);

  it("create_subtask 只产草案；确认后挂到父任务下", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "写开题报告" });
    const tools = buildTools(student.id, project.id);

    const env = envelope(
      await tools.create_subtask.execute!(
        { parentTaskId: parent.id, title: "查文献", priority: "high" as const },
        opts,
      ),
    );
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
    // 草案就是草案：子任务还没落库
    expect(await listSubtasks(student.id, parent.id)).toEqual([]);

    await expect(commitDraft(student.id, project.id, "create_subtask", env.draft)).resolves.toEqual(
      { committed: 1, conflicts: [] },
    );
    const subs = await listSubtasks(student.id, parent.id);
    expect(subs.map((s) => s.title)).toEqual(["查文献"]);
    expect(subs[0]).toMatchObject({ parentTaskId: parent.id, priority: "high" });
  });

  it("父任务不属于当前项目时，拟稿阶段就拒绝", async () => {
    const { owner, student, project, otherProject } = await scene();
    const foreign = await createTask(owner.id, otherProject.id, { title: "别处的任务" });
    const tools = buildTools(student.id, project.id);
    await expect(
      tools.create_subtask.execute!({ parentTaskId: foreign.id, title: "越界子任务" }, opts),
    ).rejects.toThrow("任务不属于该项目");
  });

  it("delete_subtask 只删子任务；主任务被拒，确认后级联删掉下级", async () => {
    const { owner, student, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "父任务" });
    const child = await createSubtask(owner.id, parent.id, { title: "子任务" });
    const grandchild = await createSubtask(owner.id, child.id, { title: "孙任务" });
    const tools = buildTools(student.id, project.id);

    const env = envelope(await tools.delete_subtask.execute!({ taskId: child.id }, opts));
    expect(env).toMatchObject({
      __draft: true,
      tool: "delete_subtask",
      draft: { projectId: project.id, taskId: child.id, title: "子任务", parentTitle: "父任务" },
    });
    // 未确认前一个都没少
    expect(await listSubtasks(student.id, parent.id)).toHaveLength(1);

    await expect(commitDraft(student.id, project.id, "delete_subtask", env.draft)).resolves.toEqual(
      { committed: 1, conflicts: [] },
    );
    expect(await listSubtasks(student.id, parent.id)).toEqual([]);
    // 孙任务随子任务级联消失
    expect(await db.select().from(tasks).where(eq(tasks.id, grandchild.id))).toHaveLength(0);

    // 主任务不能从这里删
    await expect(tools.delete_subtask.execute!({ taskId: parent.id }, opts)).rejects.toThrow(
      "只能删除子任务",
    );
  });

  it("落库口重验层级：伪造主任务 id 也不会被删", async () => {
    const { owner, project } = await scene();
    const parent = await createTask(owner.id, project.id, { title: "主任务" });
    await expect(
      commitDraft(owner.id, project.id, "delete_subtask", { taskId: parent.id }),
    ).rejects.toThrow("只能删除子任务");
    expect(await db.select().from(tasks).where(eq(tasks.id, parent.id))).toHaveLength(1);
  });
});

describe("项目助手：任务附件管理", () => {
  beforeEach(resetDb);

  it("list_attachments 列出当前项目任务附件；确认后删除", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写报告" });
    const data = Buffer.from("附件正文");
    const att = await uploadAttachment(owner.id, task.id, {
      filename: "报告.pdf",
      mimeType: "application/pdf",
      size: data.length,
      data,
    });
    const tools = buildTools(student.id, project.id);

    const rows = (await tools.list_attachments.execute!({ taskId: task.id }, opts)) as {
      attachmentId: string;
      filename: string;
      size: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attachmentId: att.id,
      filename: "报告.pdf",
      size: data.length,
    });

    const env = envelope(await tools.delete_attachment.execute!({ attachmentId: att.id }, opts));
    expect(env).toMatchObject({
      __draft: true,
      tool: "delete_attachment",
      draft: {
        projectId: project.id,
        attachmentId: att.id,
        taskId: task.id,
        taskTitle: "写报告",
        filename: "报告.pdf",
      },
    });
    // 确认前还在
    expect(await listAttachments(student.id, task.id)).toHaveLength(1);

    await expect(
      commitDraft(student.id, project.id, "delete_attachment", env.draft),
    ).resolves.toEqual({ committed: 1, conflicts: [] });
    expect(await listAttachments(student.id, task.id)).toEqual([]);
  });

  it("别项目的任务与附件都不能从当前项目操作", async () => {
    const { owner, student, project, otherProject } = await scene();
    const foreignTask = await createTask(owner.id, otherProject.id, { title: "别处任务" });
    const data = Buffer.from("别处附件");
    const foreignAtt = await uploadAttachment(owner.id, foreignTask.id, {
      filename: "别处.txt",
      size: data.length,
      data,
    });
    const tools = buildTools(student.id, project.id);

    await expect(
      tools.list_attachments.execute!({ taskId: foreignTask.id }, opts),
    ).rejects.toThrow("任务不属于该项目");
    await expect(
      tools.delete_attachment.execute!({ attachmentId: foreignAtt.id }, opts),
    ).rejects.toThrow("附件不属于该项目");
  });
});

describe("工作台助手：消息文件 → 任务附件", () => {
  beforeEach(resetDb);

  it("read_messages 给出 attachmentId；草案确认后复制字节成任务附件", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "改首页" });
    const data = Buffer.from("设计稿的二进制内容");
    await sendDm(owner.id, student.id, {
      content: "设计稿给你",
      file: { filename: "设计稿.png", mimeType: "image/png", size: data.length, data },
    });

    const tools = buildPersonalTools(student.id);
    const dm = (await tools.read_messages.execute!({ peerId: owner.id }, opts)) as {
      messages: {
        content: string;
        attachment: { attachmentId: string; filename: string; size: number } | null;
      }[];
    };
    const attachmentId = dm.messages[0].attachment?.attachmentId;
    expect(attachmentId).toBeTruthy();
    expect(dm.messages[0].attachment).toMatchObject({
      filename: "设计稿.png",
      size: data.length,
    });

    const env = envelope(
      await tools.attach_message_file_to_task.execute!(
        { attachmentId: attachmentId!, taskId: task.id },
        opts,
      ),
    );
    expect(env).toMatchObject({
      __draft: true,
      tool: ATTACH_MESSAGE_TOOL,
      draft: {
        attachmentId,
        taskId: task.id,
        filename: "设计稿.png",
        size: data.length,
        taskTitle: "改首页",
      },
    });
    // 确认前任务上没有附件
    expect(await listAttachments(student.id, task.id)).toEqual([]);

    await expect(
      commitPersonalDraft(student.id, ATTACH_MESSAGE_TOOL, env.draft),
    ).resolves.toEqual({ committed: 1, conflicts: [] });

    const list = await listAttachments(student.id, task.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      filename: "设计稿.png",
      mimeType: "image/png",
      size: data.length,
      uploaderName: "student",
    });
    // 真的是复制了字节，而不是只存了个文件名
    const downloaded = await getAttachmentForDownload(student.id, list[0].id);
    expect(Buffer.from(downloaded.data).equals(data)).toBe(true);
  });

  it("群聊文件同样可以复制到任务附件", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "准备答辩" });
    const data = Buffer.from("群文件内容");
    const group = await createGroup(owner.id, "讨论组", [student.id]);
    await sendGroupMessage(owner.id, group.id, {
      content: "",
      file: { filename: "答辩提纲.docx", mimeType: "application/msword", size: data.length, data },
    });

    const tools = buildPersonalTools(student.id);
    const out = (await tools.read_messages.execute!({ groupId: group.id }, opts)) as {
      messages: { attachment: { attachmentId: string } | null }[];
    };
    const attachmentId = out.messages[0].attachment!.attachmentId;
    const env = envelope(
      await tools.attach_message_file_to_task.execute!({ attachmentId, taskId: task.id }, opts),
    );
    await commitPersonalDraft(student.id, ATTACH_MESSAGE_TOOL, env.draft);

    const list = await listAttachments(student.id, task.id);
    expect(list.map((a) => a.filename)).toEqual(["答辩提纲.docx"]);
    const downloaded = await getAttachmentForDownload(student.id, list[0].id);
    expect(Buffer.from(downloaded.data).equals(data)).toBe(true);
  });

  it("读不到的消息附件不能被复制（外人 / 未知 id）", async () => {
    const { owner, student, outsider, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "任务" });
    const data = Buffer.from("机密");
    await sendDm(owner.id, student.id, {
      content: "",
      file: { filename: "机密.txt", mimeType: "text/plain", size: data.length, data },
    });
    const studentTools = buildPersonalTools(student.id);
    const dm = (await studentTools.read_messages.execute!({ peerId: owner.id }, opts)) as {
      messages: { attachment: { attachmentId: string } }[];
    };
    const attachmentId = dm.messages[0].attachment.attachmentId;

    const outsiderTools = buildPersonalTools(outsider.id);
    await expect(
      outsiderTools.attach_message_file_to_task.execute!({ attachmentId, taskId: task.id }, opts),
    ).rejects.toThrow("没有权限");
    await expect(
      studentTools.attach_message_file_to_task.execute!(
        { attachmentId: "00000000-0000-0000-0000-000000000000", taskId: task.id },
        opts,
      ),
    ).rejects.toThrow("附件不存在");
  });
});
