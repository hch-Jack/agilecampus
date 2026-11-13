import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { documentVersions, documents, taskActivities, taskAttachments } from "@/db/schema";
import {
  ensureDocument,
  grantEditor,
  saveDocumentAs,
} from "@/lib/documents/service";
import { resetDb } from "./helpers";
import {
  addTextAttachment,
  makeDocScene,
  setupTempUploadDir,
  teardownTempUploadDir,
} from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const access = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: access.document.id };
}

describe("saveDocumentAs：另存为副本", () => {
  it("新建附件 + 新文档 + v1(save_as)，原文档不变", async () => {
    const { owner, task, attachment, documentId } = await scene();

    const result = await saveDocumentAs({
      documentId,
      userId: owner.id,
      newFilename: "笔记-副本.txt",
      bytes: Buffer.from("副本内容"),
      mimeType: "text/plain",
    });
    expect(result.filename).toBe("笔记-副本.txt");
    expect(result.documentId).not.toBe(documentId);

    const [newDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, result.documentId));
    expect(newDoc.sourceType).toBe("task_attachment");
    expect(newDoc.filename).toBe("笔记-副本.txt");
    expect(newDoc.currentVersion).toBe(1);
    expect(newDoc.collaborationEnabled).toBe(false);
    expect(newDoc.createdById).toBe(owner.id);
    expect(newDoc.taskId).toBe(task.id);

    const [newAttachment] = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.id, newDoc.sourceId));
    expect(newAttachment.filename).toBe("笔记-副本.txt");
    expect(newAttachment.uploaderId).toBe(owner.id);
    expect(newAttachment.size).toBe(Buffer.byteLength("副本内容"));
    expect(newAttachment.storageKey).not.toBeNull();

    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, result.documentId));
    expect(versions).toHaveLength(1);
    expect(versions[0].version).toBe(1);
    expect(versions[0].note).toBe("save_as");

    // 原文档/原附件原封不动
    const [oldDoc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(oldDoc.currentVersion).toBe(1);
    expect(oldDoc.filename).toBe("notes.txt");
    const [oldAttachment] = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.id, attachment.id));
    expect(oldAttachment.storageKey).toBeNull();
    expect(oldAttachment.size).toBe(Buffer.byteLength("第一版内容"));

    const activities = await db
      .select({ type: taskActivities.type, newValue: taskActivities.newValue })
      .from(taskActivities)
      .where(
        and(eq(taskActivities.taskId, task.id), eq(taskActivities.type, "document_saved_as")),
      );
    expect(activities).toHaveLength(1);
    expect(activities[0].newValue).toBe("笔记-副本.txt");
  });

  it("另存为保留 editorState", async () => {
    const { owner, documentId } = await scene();
    const editorState = { type: "doc", content: [{ type: "paragraph" }] };
    const result = await saveDocumentAs({
      documentId,
      userId: owner.id,
      newFilename: "带状态.txt",
      bytes: Buffer.from("x"),
      mimeType: "text/plain",
      editorState,
    });
    const [version] = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, result.documentId));
    expect(version.editorState).toEqual(editorState);
  });

  it("扩展名必须与原格式一致；空名/路径分隔符被处理", async () => {
    const { owner, documentId } = await scene();

    await expect(
      saveDocumentAs({
        documentId,
        userId: owner.id,
        newFilename: "副本.pdf",
        bytes: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("相同的扩展名");

    await expect(
      saveDocumentAs({
        documentId,
        userId: owner.id,
        newFilename: "   ",
        bytes: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("文件名不能为空");

    // 文本格式内换扩展名是允许的（.txt → .md）
    const md = await saveDocumentAs({
      documentId,
      userId: owner.id,
      newFilename: "说明.md",
      bytes: Buffer.from("# 标题"),
      mimeType: "text/markdown",
    });
    expect(md.filename).toBe("说明.md");

    // 路径分隔符被剥掉，只留基础名
    const flat = await saveDocumentAs({
      documentId,
      userId: owner.id,
      newFilename: "sub/dir/深层.txt",
      bytes: Buffer.from("x"),
      mimeType: "text/plain",
    });
    expect(flat.filename).toBe("subdir深层.txt");
  });

  it("无编辑权的 teacher 被拒；被授权后可另存（文档权与任务写权解耦）", async () => {
    const { owner, teacher, documentId } = await scene();
    await expect(
      saveDocumentAs({
        documentId,
        userId: teacher.id,
        newFilename: "教师副本.txt",
        bytes: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("编辑权限");

    await grantEditor(documentId, owner.id, teacher.id);
    const result = await saveDocumentAs({
      documentId,
      userId: teacher.id,
      newFilename: "教师副本.txt",
      bytes: Buffer.from("教师内容"),
      mimeType: "text/plain",
    });
    const [doc] = await db.select().from(documents).where(eq(documents.id, result.documentId));
    expect(doc.createdById).toBe(teacher.id);
    const [attachment] = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.id, doc.sourceId));
    expect(attachment.uploaderId).toBe(teacher.id);
  });
});
