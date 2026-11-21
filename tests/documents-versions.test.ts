import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { documentVersions, documents, taskAttachments } from "@/db/schema";
import { readBlob } from "@/lib/blob-store";
import { deleteAttachment } from "@/lib/attachment";
import { createSubtask, deleteTask } from "@/lib/task";
import { DocumentLockError } from "@/lib/errors";
import { acquireLock } from "@/lib/documents/locks";
import { pruneDocumentVersions } from "@/lib/documents/blobs";
import {
  ensureDocument,
  readDocumentContent,
  restoreDocumentVersion,
  saveDocument,
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

const SESSION = "session-owner-0001";

async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const access = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: access.document.id };
}

async function saveText(
  documentId: string,
  ownerId: string,
  baseVersion: number,
  text: string,
) {
  return saveDocument({
    documentId,
    userId: ownerId,
    sessionId: SESSION,
    baseVersion,
    bytes: Buffer.from(text, "utf8"),
    mimeType: "text/plain",
    note: "manual",
  });
}

describe("restoreDocumentVersion：恢复历史版本", () => {
  it("把 v1 内容恢复成新的当前版本，旧版本保持可回退", async () => {
    const { owner, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    await saveText(documentId, owner.id, 1, "第二版内容");

    const restored = await restoreDocumentVersion({
      documentId,
      userId: owner.id,
      sessionId: SESSION,
      version: 1,
    });
    expect(restored.version).toBe(3);

    const latest = await readDocumentContent(documentId, owner.id);
    expect(latest.data.toString("utf8")).toBe("第一版内容");
    expect(latest.version).toBe(3);

    const versions = await db
      .select()
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(asc(documentVersions.version));
    expect(versions.map((v) => v.note)).toEqual(["initial", "manual", "restore"]);
    expect(versions[2].storageKey).toBe(versions[0].storageKey);
    // v2 的内容还在，随时可以再恢复
    expect((await readBlob(versions[1].storageKey)).toString("utf8")).toBe("第二版内容");
  });

  it("恢复不存在的版本 → 400；无锁 → LOCK_LOST", async () => {
    const { owner, documentId } = await scene();
    await expect(
      restoreDocumentVersion({
        documentId,
        userId: owner.id,
        sessionId: SESSION,
        version: 9,
      }),
    ).rejects.toThrow(DocumentLockError);

    await acquireLock(documentId, owner.id, SESSION);
    await expect(
      restoreDocumentVersion({
        documentId,
        userId: owner.id,
        sessionId: SESSION,
        version: 9,
      }),
    ).rejects.toThrow("版本不存在");
  });
});

describe("pruneDocumentVersions：保留最新 50 + v1", () => {
  it("裁剪旧版本，v1 与最新 50 个保留", async () => {
    const { owner, documentId } = await scene();
    expect(owner).toBeTruthy();

    const keys = Array.from(
      { length: 60 },
      () => `${randomUUID().slice(0, 2)}/${randomUUID()}`,
    );
    await db.insert(documentVersions).values(
      keys.map((storageKey, i) => ({
        documentId,
        version: i + 1,
        filename: "notes.txt",
        mimeType: "text/plain",
        size: 1,
        storageKey,
        note: i === 0 ? "initial" : "manual",
        createdById: owner.id,
      })),
    );

    await pruneDocumentVersions(documentId);

    const left = await db
      .select({ version: documentVersions.version })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId))
      .orderBy(asc(documentVersions.version));
    expect(left).toHaveLength(51);
    expect(left[0].version).toBe(1);
    expect(left[1].version).toBe(11);
    expect(left[left.length - 1].version).toBe(60);
  });
});

describe("版本与来源的清理", () => {
  it("删除附件时清掉文档行、版本行与全部版本 blob", async () => {
    const { owner, attachment, documentId } = await scene();
    await acquireLock(documentId, owner.id, SESSION);
    await saveText(documentId, owner.id, 1, "第二版内容");

    const versions = await db
      .select({ storageKey: documentVersions.storageKey })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    expect(versions).toHaveLength(2);
    for (const v of versions) {
      expect((await readBlob(v.storageKey)).length).toBeGreaterThan(0);
    }

    await deleteAttachment(owner.id, attachment.id);

    expect(await db.select().from(documents)).toHaveLength(0);
    expect(await db.select().from(documentVersions)).toHaveLength(0);
    expect(
      await db.select().from(taskAttachments).where(eq(taskAttachments.id, attachment.id)),
    ).toHaveLength(0);
    for (const v of versions) {
      await expect(readBlob(v.storageKey)).rejects.toThrow("文件不存在");
    }
  });

  it("删除任务时递归清理子任务树的附件与文档 blob", async () => {
    const s = await makeDocScene();
    const subtask = await createSubtask(s.owner.id, s.task.id, { title: "子任务" });
    const attachment = await addTextAttachment(s.student.id, subtask.id, "sub.txt", "子任务文件");
    const { document } = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
    await acquireLock(document.id, s.owner.id, SESSION);
    await saveText(document.id, s.owner.id, 1, "子任务新内容");

    const keys = await db
      .select({ storageKey: documentVersions.storageKey })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, document.id));
    expect(keys).toHaveLength(2);

    await deleteTask(s.owner.id, s.task.id);

    expect(await db.select().from(documents)).toHaveLength(0);
    expect(await db.select().from(taskAttachments)).toHaveLength(0);
    for (const k of keys) {
      await expect(readBlob(k.storageKey)).rejects.toThrow("文件不存在");
    }
  });
});
