import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { documentVersions, documents, taskAttachments } from "@/db/schema";
import { readBlob } from "@/lib/blob-store";
import { uploadAttachment } from "@/lib/attachment";
import { DocumentLockError, VersionConflictError } from "@/lib/errors";
import { acquireLock, releaseLock } from "@/lib/documents/locks";
import {
  ensureDocument,
  getDocumentState,
  getVersionEditorState,
  readDocumentContent,
  saveDocument,
} from "@/lib/documents/service";
import { resetDb } from "./helpers";
import {
  addTextAttachment,
  listBlobFiles,
  makeDocScene,
  setupTempUploadDir,
  teardownTempUploadDir,
} from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const SESSION = "session-owner-0001";

async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const access = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: access.document.id };
}

describe("ensureDocument", () => {
  it("重复打开复用同一条 documents 行", async () => {
    const { owner, attachment } = await scene();
    const first = await ensureDocument(owner.id, "task_attachment", attachment.id);
    const second = await ensureDocument(owner.id, "task_attachment", attachment.id);
    expect(second.document.id).toBe(first.document.id);
    expect(await db.select().from(documents)).toHaveLength(1);
  });

  it("并发打开也只有一个文档行", async () => {
    const s = await makeDocScene();
    const attachment = await addTextAttachment(s.student.id, s.task.id);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureDocument(s.owner.id, "task_attachment", attachment.id),
      ),
    );
    expect(new Set(results.map((r) => r.document.id)).size).toBe(1);
    expect(await db.select().from(documents)).toHaveLength(1);
  });
});

describe("saveDocument：文本保存到原文件", () => {
  it("写新 blob、更新附件行、版本递增并留下 v1/v2", async () => {
    const { owner, attachment, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);

    const result = await saveDocument({
      documentId,
      userId: owner.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("第二版内容", "utf8"),
      mimeType: "text/plain; charset=utf-8",
      note: "manual",
    });
    expect(result.version).toBe(2);
    expect(result.size).toBe(Buffer.byteLength("第二版内容"));

    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.currentVersion).toBe(2);

    const [row] = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.id, attachment.id));
    expect(row.storageKey).not.toBeNull();
    expect(row.data.length).toBe(0);
    expect(row.size).toBe(Buffer.byteLength("第二版内容"));
    expect((await readBlob(row.storageKey!)).toString("utf8")).toBe("第二版内容");

    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(asc(documentVersions.version));
    expect(versions.map((v) => [v.version, v.note])).toEqual([
      [1, "initial"],
      [2, "manual"],
    ]);
    // v1 是原始内容物化出的独立 blob，未被当前附件引用覆盖
    expect((await readBlob(versions[0].storageKey)).toString("utf8")).toBe("第一版内容");

    const content = await readDocumentContent(documentId, owner.id);
    expect(content.data.toString("utf8")).toBe("第二版内容");
    expect(content.version).toBe(2);
  });

  it("历史版本可读，字节是当次保存的内容", async () => {
    const { owner, attachment, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    await saveDocument({
      documentId,
      userId: owner.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("第二版", "utf8"),
      mimeType: "text/plain",
      note: "manual",
    });

    const v1 = await readDocumentContent(documentId, owner.id, 1);
    expect(v1.data.toString("utf8")).toBe("第一版内容");
    expect(v1.version).toBe(1);
    // 当前附件内容不受影响
    const [row] = await db
      .select({ size: taskAttachments.size })
      .from(taskAttachments)
      .where(eq(taskAttachments.id, attachment.id));
    expect(row.size).toBe(Buffer.byteLength("第二版"));
  });

  it("docx 编辑器状态随版本落库", async () => {
    const { owner, task } = await makeDocScene();
    const docxAttachment = await uploadAttachment(owner.id, task.id, {
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      data: Buffer.from("placeholder-docx"),
    });
    const { document } = await ensureDocument(owner.id, "task_attachment", docxAttachment.id);
    const documentId = document.id;

    await acquireLock(documentId, owner.id, SESSION);
    const editorState = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "富文本" }] }],
    };
    await saveDocument({
      documentId,
      userId: owner.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("伪 docx 字节"),
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      editorState,
      note: "autosave",
    });
    expect(await getVersionEditorState(documentId, 2)).toEqual(editorState);
  });

  it("旧 baseVersion 返回 409 冲突且不写版本、不残留 blob", async () => {
    const { owner, attachment, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    const before = await listBlobFiles();

    const error = await saveDocument({
      documentId,
      userId: owner.id,
      sessionId: SESSION,
      baseVersion: 99,
      bytes: Buffer.from("过期修改"),
      mimeType: "text/plain",
    }).catch((e) => e as VersionConflictError);

    expect(error).toBeInstanceOf(VersionConflictError);
    expect((error as VersionConflictError).currentVersion).toBe(1);
    expect(await listBlobFiles()).toEqual(before);
    expect(
      await db.select().from(documentVersions).where(eq(documentVersions.documentId, documentId)),
    ).toHaveLength(0);

    const [row] = await db
      .select({ storageKey: taskAttachments.storageKey, size: taskAttachments.size })
      .from(taskAttachments)
      .where(eq(taskAttachments.id, attachment.id));
    expect(row.storageKey).toBeNull();
    expect(row.size).toBe(Buffer.byteLength("第一版内容"));
  });

  it("同一 baseVersion 并发保存只有一胜，败者事务回滚且 blob 不残留", async () => {
    const { owner, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    const before = await listBlobFiles();

    const results = await Promise.allSettled([
      saveDocument({
        documentId,
        userId: owner.id,
        sessionId: SESSION,
        baseVersion: 1,
        bytes: Buffer.from("甲组修改"),
        mimeType: "text/plain",
      }),
      saveDocument({
        documentId,
        userId: owner.id,
        sessionId: SESSION,
        baseVersion: 1,
        bytes: Buffer.from("乙组修改"),
        mimeType: "text/plain",
      }),
    ]);

    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(VersionConflictError);

    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.currentVersion).toBe(2);
    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    expect(versions).toHaveLength(2);

    // 新增文件：获胜版本 + 物化的 v1；败者写入的 blob 已在回滚时删除
    expect((await listBlobFiles()).length).toBe(before.length + 2);
  });

  it("锁丢失后保存被拒（DocumentLockError: lost）", async () => {
    const { owner, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    await releaseLock(documentId, owner.id, SESSION);

    const error = await saveDocument({
      documentId,
      userId: owner.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("无锁保存"),
      mimeType: "text/plain",
    }).catch((e) => e as DocumentLockError);

    expect(error).toBeInstanceOf(DocumentLockError);
    expect((error as DocumentLockError).reason).toBe("lost");
  });

  it("空内容与超限内容在写 blob 前就被拒", async () => {
    const { owner, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    const before = await listBlobFiles();

    await expect(
      saveDocument({
        documentId,
        userId: owner.id,
        sessionId: SESSION,
        baseVersion: 1,
        bytes: Buffer.alloc(0),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("不能保存空文档");

    await expect(
      saveDocument({
        documentId,
        userId: owner.id,
        sessionId: SESSION,
        baseVersion: 1,
        bytes: Buffer.alloc(2 * 1024 * 1024 + 1, 65),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("大小上限");

    expect(await listBlobFiles()).toEqual(before);
  });

  it("无编辑权的 teacher 保存被拒", async () => {
    const { teacher, documentId } = await scene();
    await expect(
      saveDocument({
        documentId,
        userId: teacher.id,
        sessionId: "session-teacher-1",
        baseVersion: 1,
        bytes: Buffer.from("越权"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("编辑权限");
  });
});

describe("getDocumentState", () => {
  it("管理员能拿到锁、版本与授权列表；只读成员拿不到授权列表", async () => {
    const { owner, teacher, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);

    const adminState = await getDocumentState(documentId, owner.id);
    expect(adminState.lock?.userId).toBe(owner.id);
    expect(adminState.versions).toHaveLength(0);
    expect(Array.isArray(adminState.editors)).toBe(true);

    const teacherState = await getDocumentState(documentId, teacher.id);
    expect(teacherState.access.canEdit).toBe(false);
    expect(teacherState.lock?.userId).toBe(owner.id);
    expect(teacherState.editors).toEqual([]);
  });
});
