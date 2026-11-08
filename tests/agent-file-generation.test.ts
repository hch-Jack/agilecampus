import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { getAttachmentForDownload, listAttachments } from "@/lib/attachment";
import {
  getDmAttachmentForDownload,
  listMessages,
  sendDm,
  stageDmAttachment,
} from "@/lib/dm";
import { readStoredContent, saveBlobFromStream } from "@/lib/blob-store";
import {
  copyAgentFileToTask,
  getAgentFileForDownload,
  saveAgentFile,
} from "@/lib/agent/files";
import { sendChatMessage } from "@/lib/chat-transfer";
import {
  SAVE_FILE_TO_TASK_TOOL,
  SEND_MESSAGE_TOOL,
  buildPersonalTools,
} from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { POST as assistantUploadRoute } from "@/app/api/assistant/files/route";
import { POST as taskUploadRoute } from "@/app/api/attachments/upload/route";
import { POST as dmUploadRoute } from "@/app/api/dm/attachments/upload/route";
import { resetDb } from "./helpers";

// 上传路由从 session 取身份；库与工具层不碰 auth
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

const opts = {} as never;

let dir: string;
let prevUploadDir: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "ac-gen-"));
  prevUploadDir = process.env.UPLOAD_DIR;
  process.env.UPLOAD_DIR = dir;
});

afterAll(async () => {
  if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
  else process.env.UPLOAD_DIR = prevUploadDir;
  await rm(dir, { recursive: true, force: true });
});

async function makeUser(email: string) {
  return createUser({ email, password: "password123", name: email.split("@")[0] });
}

async function scene() {
  const owner = await makeUser("owner@example.com");
  const team = await createTeam(owner.id, "东吴实验室");
  const student = await makeUser("student@example.com");
  await joinTeam(student.id, team.inviteCode);
  const outsider = await makeUser("outsider@example.com");
  const peer = await makeUser("peer@example.com");
  const project = await createProject(owner.id, team.id, { name: "赤壁演习" });
  const task = await createTask(owner.id, project.id, { title: "交周报" });
  return { owner, student, outsider, peer, team, project, task };
}

function uploadRequest(url: string, body: string) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
}

describe("create_file：生成 → 下载 / 读回 / 进任务 / 发消息", () => {
  beforeEach(resetDb);

  it("生成 markdown：返回预览信封，正文可按 fileId 读回", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.create_file.execute!(
      { filename: "周报.md", content: "# 本周\n\n- 完成 X" },
      opts,
    )) as { __showFile: true; fileId: string; filename: string; url: string };

    expect(env.__showFile).toBe(true);
    expect(env.filename).toBe("周报.md");
    expect(env.url).toBe(`/api/assistant/files/${env.fileId}`);

    const row = await getAgentFileForDownload(student.id, env.fileId);
    expect(row.storageKey).toBeNull(); // 生成的小文件仍走库内 data
    expect((await readStoredContent(row)).toString("utf8")).toBe("# 本周\n\n- 完成 X");

    const read = (await tools.read_file.execute!(
      { source: "file", fileId: env.fileId },
      opts,
    )) as { text?: string };
    expect(read.text).toContain("完成 X");
  });

  it("生成 docx 后，read_file 能抽回正文（生成链路与解析链路互通）", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);

    const env = (await tools.create_file.execute!(
      { filename: "开题报告.docx", content: "第一章 研究背景\n已有研究" },
      opts,
    )) as { fileId: string };

    const read = (await tools.read_file.execute!(
      { source: "file", fileId: env.fileId },
      opts,
    )) as { text?: string };
    expect(read.text).toContain("第一章 研究背景");
  });

  it("生成的文件进任务：草案 → 确认，字节与文件名都对", async () => {
    const { student, task } = await scene();
    const tools = buildPersonalTools(student.id);
    const env = (await tools.create_file.execute!(
      { filename: "资料.csv", content: "a,b\n1,2" },
      opts,
    )) as { fileId: string };

    const draft = (await tools.save_file_to_task.execute!(
      { fileId: env.fileId, taskId: task.id },
      opts,
    )) as { __draft: true; tool: string; draft: Record<string, unknown> };
    expect(draft.tool).toBe(SAVE_FILE_TO_TASK_TOOL);

    await commitPersonalDraft(student.id, SAVE_FILE_TO_TASK_TOOL, draft.draft);
    const list = await listAttachments(student.id, task.id);
    expect(list.map((a) => a.filename)).toEqual(["资料.csv"]);
    const stored = await getAttachmentForDownload(student.id, list[0].id);
    expect((await readStoredContent(stored)).toString("utf8")).toBe("a,b\n1,2");
  });

  it("生成的文件作为消息发送：fileSource=file 草案 → 确认，私信附件内容一致", async () => {
    const { student, peer } = await scene();
    const tools = buildPersonalTools(student.id);
    const env = (await tools.create_file.execute!(
      { filename: "给同学.txt", content: "你好呀" },
      opts,
    )) as { fileId: string };

    const draft = (await tools.send_message.execute!(
      {
        targetType: "user",
        targetId: peer.id,
        content: "文件在这",
        fileSource: "file",
        attachmentId: env.fileId,
      },
      opts,
    )) as { __draft: true; tool: string; draft: Record<string, unknown> };
    expect(draft.tool).toBe(SEND_MESSAGE_TOOL);

    await commitPersonalDraft(student.id, SEND_MESSAGE_TOOL, draft.draft);
    const { messages } = await listMessages(student.id, peer.id);
    const sent = messages.at(-1);
    expect(sent?.attachment?.filename).toBe("给同学.txt");
    const stored = await getDmAttachmentForDownload(student.id, sent!.attachment!.id);
    expect((await readStoredContent(stored)).toString("utf8")).toBe("你好呀");
  });

  it("磁盘上的文件复制进任务/消息时按 blob 复制，不读进内存", async () => {
    const { student, peer, task } = await scene();
    const source = await saveBlobFromStream(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("磁盘正文"));
          c.close();
        },
      }),
    );
    const row = await saveAgentFile(student.id, {
      filename: "大文件.txt",
      mimeType: "text/plain",
      storageKey: source.storageKey,
    });

    const copied = await copyAgentFileToTask(student.id, row.id, task.id);
    const stored = await getAttachmentForDownload(student.id, copied.id);
    expect(stored.storageKey).toBeTruthy();
    expect((await readStoredContent(stored)).toString("utf8")).toBe("磁盘正文");

    await sendChatMessage(
      student.id,
      { kind: "user", id: peer.id },
      { attachment: { source: "file", attachmentId: row.id } },
    );
    const { messages } = await listMessages(student.id, peer.id);
    const dmStored = await getDmAttachmentForDownload(
      student.id,
      messages.at(-1)!.attachment!.id,
    );
    expect(dmStored.storageKey).toBeTruthy();
    expect((await readStoredContent(dmStored)).toString("utf8")).toBe("磁盘正文");
  });
});

describe("流式上传路由", () => {
  beforeEach(resetDb);

  it("助手文件 raw body 上传：落盘、可下载、元数据正确", async () => {
    const { student } = await scene();
    authMock.userId = student.id;

    const res = await assistantUploadRoute(
      uploadRequest(
        `http://test/api/assistant/files?name=${encodeURIComponent("笔记.txt")}&type=text%2Fplain`,
        "流式写入的正文",
      ),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; filename: string; size: number };
    expect(data.filename).toBe("笔记.txt");
    expect(data.size).toBe(Buffer.byteLength("流式写入的正文"));

    const row = await getAgentFileForDownload(student.id, data.id);
    expect(row.storageKey).toBeTruthy();
    expect((await readStoredContent(row)).toString("utf8")).toBe("流式写入的正文");
  });

  it("任务附件上传：有写权限才收；附件元数据与字节都落在磁盘", async () => {
    const { student, outsider, task } = await scene();
    const url = (name: string) =>
      `http://test/api/attachments/upload?taskId=${task.id}&name=${encodeURIComponent(name)}&type=text%2Fplain`;

    authMock.userId = outsider.id;
    const denied = await taskUploadRoute(uploadRequest(url("x.txt"), "x"));
    expect(denied.status).toBe(403);

    authMock.userId = student.id;
    const ok = await taskUploadRoute(uploadRequest(url("说明.txt"), "任务正文"));
    expect(ok.status).toBe(200);
    const data = (await ok.json()) as { id: string };
    const row = await getAttachmentForDownload(student.id, data.id);
    expect(row.storageKey).toBeTruthy();
    expect((await readStoredContent(row)).toString("utf8")).toBe("任务正文");
  });

  it("消息附件预上传 → 发私信：附件内容与发送人归属都对", async () => {
    const { student, outsider, peer } = await scene();
    authMock.userId = student.id;

    const res = await dmUploadRoute(
      uploadRequest(
        `http://test/api/dm/attachments/upload?name=${encodeURIComponent("聊天文件.txt")}&type=text%2Fplain`,
        "聊天正文",
      ),
    );
    expect(res.status).toBe(200);
    const staged = (await res.json()) as { id: string };

    // 别人的预上传附件认领不了
    await expect(
      sendDm(outsider.id, peer.id, { content: "", attachmentId: staged.id }),
    ).rejects.toThrow("附件不存在");

    await sendDm(student.id, peer.id, { content: "收文件", attachmentId: staged.id });
    const { messages } = await listMessages(student.id, peer.id);
    expect(messages.at(-1)?.attachment?.id).toBe(staged.id);
    const stored = await getDmAttachmentForDownload(student.id, staged.id);
    expect((await readStoredContent(stored)).toString("utf8")).toBe("聊天正文");

    // 同一个预上传附件不能发第二次
    await expect(
      sendDm(student.id, peer.id, { content: "", attachmentId: staged.id }),
    ).rejects.toThrow("附件已发送");
  });

  it("未登录/缺文件名/空 body 都被拒", async () => {
    const { student } = await scene();
    authMock.userId = null;
    expect(
      (await assistantUploadRoute(uploadRequest("http://test/api/assistant/files?name=a.txt", "x")))
        .status,
    ).toBe(401);

    authMock.userId = student.id;
    expect(
      (await assistantUploadRoute(uploadRequest("http://test/api/assistant/files", "x"))).status,
    ).toBe(400);
    expect(
      (await assistantUploadRoute(uploadRequest("http://test/api/assistant/files?name=a.txt", "")))
        .status,
    ).toBe(413);
  });

  it("预上传但没有消息引用时，陌生人的下载路径仍取不到", async () => {
    const { student, outsider } = await scene();
    const staged = await stageDmAttachment(student.id, {
      filename: "孤儿.txt",
      data: Buffer.from("x"),
    });
    await expect(getDmAttachmentForDownload(outsider.id, staged.id)).rejects.toThrow(
      "附件不存在",
    );
  });
});
