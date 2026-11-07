import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/db";
import { dmAttachments } from "@/db/schema";
import { createUser } from "@/lib/user";
import { createTeam, joinTeam } from "@/lib/team";
import { createProject } from "@/lib/project";
import { createTask } from "@/lib/task";
import { listAttachments, uploadAttachment } from "@/lib/attachment";
import { sendDm } from "@/lib/dm";
import {
  copyAgentFileToTask,
  deleteAgentFile,
  getAgentFileForDownload,
  getAgentFileMeta,
  loadAttachmentMetas,
  readAgentFileText,
  readMessageAttachmentText,
  readTaskAttachmentText,
  saveAgentFile,
} from "@/lib/agent/files";
import { extractFileText, FILE_TEXT_MAX_CHARS } from "@/lib/agent/file-text";
import {
  SAVE_FILE_TO_TASK_TOOL,
  buildPersonalTools,
  buildTools,
} from "@/lib/agent/tools";
import { commitPersonalDraft } from "@/lib/agent/commit";
import { AppError } from "@/lib/errors";
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

const opts = {} as never;

function envelope(out: unknown) {
  return out as { __draft: true; tool: string; draft: Record<string, unknown> };
}

function textFile(filename: string, text: string, mimeType = "text/plain") {
  const data = Buffer.from(text, "utf8");
  return { filename, mimeType, size: data.byteLength, data };
}

// ---- 造 docx：mammoth 只认 zip 里的 word/document.xml，这里手搓一个「不压缩」的最小包 ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const body = entry.data;
    const crc = crc32(body);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // 存储（不压缩）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    parts.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function makeDocx(text: string): Buffer {
  return zipStore([
    {
      name: "[Content_Types].xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
      ),
    },
  ]);
}

describe("助手文件存取（agent_files）", () => {
  beforeEach(resetDb);

  it("存进去的文件能按 id 取回元数据与字节", async () => {
    const user = await makeUser("student@example.com");
    const input = textFile("开题报告.txt", "第一章：研究背景");
    const saved = await saveAgentFile(user.id, input);

    expect(saved).toMatchObject({
      filename: "开题报告.txt",
      mimeType: "text/plain",
      size: input.size,
    });
    expect(await getAgentFileMeta(user.id, saved.id)).toMatchObject({
      id: saved.id,
      filename: "开题报告.txt",
    });
    const download = await getAgentFileForDownload(user.id, saved.id);
    expect(Buffer.from(download.data).toString("utf8")).toBe("第一章：研究背景");
  });

  it("空文件与超过 1GB 的文件都拒收", async () => {
    const user = await makeUser("student@example.com");
    await expect(
      saveAgentFile(user.id, { filename: "空.txt", size: 0, data: Buffer.alloc(0) }),
    ).rejects.toThrow("不能上传空文件");
    await expect(
      saveAgentFile(user.id, {
        filename: "大.bin",
        size: 1024 * 1024 * 1024 + 1,
        data: Buffer.alloc(1),
      }),
    ).rejects.toThrow(AppError);
  });

  it("只认 owner：别人取不到、删不掉，也当「不存在」而不是 403", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const saved = await saveAgentFile(owner.id, textFile("私有.txt", "只给自己看"));

    await expect(getAgentFileMeta(other.id, saved.id)).rejects.toThrow("文件不存在");
    await expect(getAgentFileForDownload(other.id, saved.id)).rejects.toThrow("文件不存在");
    await expect(deleteAgentFile(other.id, saved.id)).rejects.toThrow("文件不存在");
    // 原文没被别人的删除请求带走
    expect((await getAgentFileMeta(owner.id, saved.id)).filename).toBe("私有.txt");

    await deleteAgentFile(owner.id, saved.id);
    await expect(getAgentFileMeta(owner.id, saved.id)).rejects.toThrow("文件不存在");
  });

  it("loadAttachmentMetas：按传入顺序返回、去重，别人的 id 整体拒绝", async () => {
    const owner = await makeUser("owner@example.com");
    const other = await makeUser("other@example.com");
    const a = await saveAgentFile(owner.id, textFile("a.txt", "甲"));
    const b = await saveAgentFile(owner.id, textFile("b.txt", "乙"));

    expect((await loadAttachmentMetas(owner.id, [b.id, a.id, b.id])).map((m) => m.filename)).toEqual([
      "b.txt",
      "a.txt",
    ]);
    expect(await loadAttachmentMetas(owner.id, [])).toEqual([]);
    await expect(loadAttachmentMetas(other.id, [a.id])).rejects.toThrow("有文件不存在或已被删除");
  });

  it("一句话最多带 5 个文件", async () => {
    const owner = await makeUser("owner@example.com");
    const ids = [];
    for (let i = 0; i < 6; i++) {
      ids.push((await saveAgentFile(owner.id, textFile(`f${i}.txt`, String(i)))).id);
    }
    await expect(loadAttachmentMetas(owner.id, ids)).rejects.toThrow("最多带 5 个文件");
  });
});

describe("extractFileText：把正文抽成纯文本", () => {
  it("文本文件按 UTF-8 解码，并去掉 BOM 与 NUL", async () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("你好\u0000世界")]);
    const out = await extractFileText({
      filename: "笔记.txt",
      mimeType: "text/plain",
      data: raw,
    });
    expect(out).toEqual({ text: "你好世界", truncated: false });
  });

  it("超长文本截到 FILE_TEXT_MAX_CHARS 并标记 truncated", async () => {
    const out = await extractFileText({
      filename: "长日志.log",
      mimeType: "text/plain",
      data: Buffer.from("a".repeat(FILE_TEXT_MAX_CHARS + 100)),
    });
    expect(out.truncated).toBe(true);
    expect(out.text?.length).toBe(FILE_TEXT_MAX_CHARS);
  });

  it("docx 抽得到正文（mammoth）", async () => {
    const out = await extractFileText({
      filename: "开题报告.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: makeDocx("研究背景与意义"),
    });
    expect(out).toMatchObject({ text: "研究背景与意义", truncated: false });
  });

  it("xlsx 逐表转 CSV，并标出工作表名", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ["姓名", "分数"],
        ["关羽", 95],
      ]),
      "成绩",
    );
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const out = await extractFileText({
      filename: "成绩.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      data: buf,
    });
    expect(out.note).toBeUndefined();
    expect(out.text).toContain("## 工作表：成绩");
    expect(out.text).toContain("关羽,95");
  });

  it("PDF / 旧版 .doc 不解析，给一句说明（不抛错）", async () => {
    for (const filename of ["论文.pdf", "旧稿.doc"]) {
      const out = await extractFileText({ filename, mimeType: null, data: Buffer.from("x") });
      expect(out.text).toBeUndefined();
      expect(out.note).toContain("暂不支持抽取正文");
    }
  });

  it("坏掉的 docx 变成 note，而不是把整轮请求炸掉", async () => {
    const out = await extractFileText({
      filename: "坏的.docx",
      mimeType: null,
      data: Buffer.from("not a zip"),
    });
    expect(out.text).toBeUndefined();
    expect(out.note).toContain("文件解析失败");
  });
});

describe("read_file：个人助手的三种来源", () => {
  beforeEach(resetDb);

  it("source=file 读自己随消息上传的文件", async () => {
    const { student } = await scene();
    const saved = await saveAgentFile(student.id, textFile("需求.txt", "要做导出"));
    const tools = buildPersonalTools(student.id);

    const out = await tools.read_file.execute!({ source: "file", fileId: saved.id }, opts);
    expect(out).toMatchObject({ filename: "需求.txt", text: "要做导出", truncated: false });
    expect(await readAgentFileText(student.id, saved.id)).toMatchObject({ text: "要做导出" });
  });

  it("source=file 不给 fileId → 明确的报错", async () => {
    const { student } = await scene();
    const tools = buildPersonalTools(student.id);
    await expect(tools.read_file.execute!({ source: "file" }, opts)).rejects.toThrow("缺少 fileId");
  });

  it("source=task 读任务附件（项目成员）", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "交材料" });
    const input = textFile("说明.md", "# 提交说明");
    const att = await uploadAttachment(owner.id, task.id, input);
    const tools = buildPersonalTools(student.id);

    const out = await tools.read_file.execute!({ source: "task", attachmentId: att.id }, opts);
    expect(out).toMatchObject({ filename: "说明.md", text: "# 提交说明" });
    expect(await readTaskAttachmentText(student.id, att.id)).toMatchObject({ text: "# 提交说明" });
  });

  it("source=task 读不到别的项目的附件", async () => {
    const { owner, outsider, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "交材料" });
    const att = await uploadAttachment(owner.id, task.id, textFile("说明.md", "正文"));
    const tools = buildPersonalTools(outsider.id);

    await expect(
      tools.read_file.execute!({ source: "task", attachmentId: att.id }, opts),
    ).rejects.toThrow(AppError);
  });

  it("source=message 读私信附件", async () => {
    const { student, outsider } = await scene();
    await sendDm(student.id, outsider.id, {
      content: "看这个",
      file: textFile("附件.txt", "私信里的内容"),
    });
    const [att] = await db
      .select({ id: dmAttachments.id })
      .from(dmAttachments)
      .where(eq(dmAttachments.uploaderId, student.id));
    expect(att).toBeTruthy();

    const tools = buildPersonalTools(outsider.id);
    const out = await tools.read_file.execute!({ source: "message", attachmentId: att.id }, opts);
    expect(out).toMatchObject({ filename: "附件.txt", text: "私信里的内容" });
    expect(await readMessageAttachmentText(student.id, att.id)).toMatchObject({
      text: "私信里的内容",
    });
  });
});

describe("项目助手的 read_file 只看本项目附件", () => {
  beforeEach(resetDb);

  it("本项目附件可读；别的项目附件被拒", async () => {
    const { owner, project, otherProject } = await scene();
    const task = await createTask(owner.id, project.id, { title: "甲" });
    const otherTask = await createTask(owner.id, otherProject.id, { title: "乙" });
    const att = await uploadAttachment(owner.id, task.id, textFile("甲.txt", "本项目"));
    const otherAtt = await uploadAttachment(owner.id, otherTask.id, textFile("乙.txt", "别项目"));
    const tools = buildTools(owner.id, project.id);

    expect(await tools.read_file.execute!({ attachmentId: att.id }, opts)).toMatchObject({
      text: "本项目",
    });
    await expect(
      tools.read_file.execute!({ attachmentId: otherAtt.id }, opts),
    ).rejects.toThrow("附件不属于该项目");
  });
});

describe("save_file_to_task：对话文件复制进任务附件", () => {
  beforeEach(resetDb);

  it("草案带文件名/大小/任务标题；确认后真的复制成任务附件", async () => {
    const { owner, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const input = textFile("资料.txt", "参考资料正文");
    const file = await saveAgentFile(owner.id, input);
    const tools = buildPersonalTools(owner.id);

    const env = envelope(await tools.save_file_to_task.execute!({ fileId: file.id, taskId: task.id }, opts));
    expect(env).toMatchObject({
      __draft: true,
      tool: SAVE_FILE_TO_TASK_TOOL,
      draft: {
        fileId: file.id,
        taskId: task.id,
        filename: "资料.txt",
        size: input.size,
        taskTitle: "写开题报告",
      },
    });
    // 草案只是草案：任务附件里还没有
    expect(await listAttachments(owner.id, task.id)).toEqual([]);

    expect(await commitPersonalDraft(owner.id, SAVE_FILE_TO_TASK_TOOL, env.draft)).toEqual({
      committed: 1,
      conflicts: [],
    });
    const list = await listAttachments(owner.id, task.id);
    expect(list.map((a) => a.filename)).toEqual(["资料.txt"]);
    expect(list[0].size).toBe(input.size);
  });

  it("别人的文件拟不成草案（只认自己的文件）", async () => {
    const { owner, student, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const file = await saveAgentFile(owner.id, textFile("私有.txt", "别人看不到"));
    const tools = buildPersonalTools(student.id);

    await expect(
      tools.save_file_to_task.execute!({ fileId: file.id, taskId: task.id }, opts),
    ).rejects.toThrow("文件不存在");
  });

  it("对任务没有写权限时，拟草案阶段就拒绝", async () => {
    const { owner, outsider, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const file = await saveAgentFile(outsider.id, textFile("我的.txt", "正文"));
    const tools = buildPersonalTools(outsider.id);

    await expect(
      tools.save_file_to_task.execute!({ fileId: file.id, taskId: task.id }, opts),
    ).rejects.toThrow(AppError);
  });

  it("copyAgentFileToTask 复制的是字节副本：删掉源文件不影响任务附件", async () => {
    const { owner, project } = await scene();
    const task = await createTask(owner.id, project.id, { title: "写开题报告" });
    const file = await saveAgentFile(owner.id, textFile("副本.txt", "正文"));
    const copied = await copyAgentFileToTask(owner.id, file.id, task.id);
    expect(copied.filename).toBe("副本.txt");

    await deleteAgentFile(owner.id, file.id);
    expect((await listAttachments(owner.id, task.id)).map((a) => a.id)).toEqual([copied.id]);
  });
});
