import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { documentLocks } from "@/db/schema";
import { DocumentLockError } from "@/lib/errors";
import {
  acquireLock,
  getLockView,
  releaseLock,
  touchLock,
} from "@/lib/documents/locks";
import {
  ensureDocument,
  saveDocument,
  setCollaboration,
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

const OWNER_SESSION = "session-owner-0001";
const STUDENT_SESSION = "session-student-001";

async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const access = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: access.document.id };
}

describe("单人编辑锁", () => {
  it("获取后可见；他人获取返回 null 且锁仍属前者", async () => {
    const { owner, student, documentId } = await scene();
    const lock = await acquireLock(documentId, owner.id, OWNER_SESSION);
    expect(lock?.userId).toBe(owner.id);

    expect(await acquireLock(documentId, student.id, STUDENT_SESSION)).toBeNull();
    const view = await getLockView(documentId);
    expect(view?.userId).toBe(owner.id);
    expect(view?.sessionId).toBe(OWNER_SESSION);
  });

  it("同一用户换标签页（新 session）可接管，旧 session 续约失败", async () => {
    const { owner, documentId } = await scene();
    await acquireLock(documentId, owner.id, OWNER_SESSION);

    const taken = await acquireLock(documentId, owner.id, "session-owner-0002");
    expect(taken?.sessionId).toBe("session-owner-0002");
    expect(await touchLock(documentId, owner.id, OWNER_SESSION)).toBeNull();
    expect(await touchLock(documentId, owner.id, "session-owner-0002")).not.toBeNull();
  });

  it("过期锁被他人抢占", async () => {
    const { owner, student, documentId } = await scene();
    await acquireLock(documentId, owner.id, OWNER_SESSION);
    await db
      .update(documentLocks)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(documentLocks.documentId, documentId));

    expect(await touchLock(documentId, owner.id, OWNER_SESSION)).toBeNull();
    const taken = await acquireLock(documentId, student.id, STUDENT_SESSION);
    expect(taken?.userId).toBe(student.id);
  });

  it("续约会延长 TTL", async () => {
    const { owner, documentId } = await scene();
    await acquireLock(documentId, owner.id, OWNER_SESSION);
    await db
      .update(documentLocks)
      .set({ expiresAt: sql`now() + interval '10 seconds'` })
      .where(eq(documentLocks.documentId, documentId));

    const renewed = await touchLock(documentId, owner.id, OWNER_SESSION);
    expect(renewed).not.toBeNull();
    const remainingSec = (new Date(renewed!.expiresAt).getTime() - Date.now()) / 1000;
    expect(remainingSec).toBeGreaterThan(60);
  });

  it("释放后可被他人获取", async () => {
    const { owner, student, documentId } = await scene();
    await acquireLock(documentId, owner.id, OWNER_SESSION);
    await releaseLock(documentId, owner.id, OWNER_SESSION);
    expect(await getLockView(documentId)).toBeNull();

    const taken = await acquireLock(documentId, student.id, STUDENT_SESSION);
    expect(taken?.userId).toBe(student.id);
  });

  it("并发获取只有一人成功", async () => {
    const { owner, student, documentId } = await scene();
    const [a, b] = await Promise.all([
      acquireLock(documentId, owner.id, OWNER_SESSION),
      acquireLock(documentId, student.id, STUDENT_SESSION),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("他人持锁时保存被拒", async () => {
    const { owner, student, documentId } = await scene();
    await acquireLock(documentId, owner.id, OWNER_SESSION);
    const error = await saveDocument({
      documentId,
      userId: student.id,
      sessionId: STUDENT_SESSION,
      baseVersion: 1,
      bytes: Buffer.from("抢写"),
      mimeType: "text/plain",
    }).catch((e) => e as DocumentLockError);
    expect(error).toBeInstanceOf(DocumentLockError);
    expect((error as DocumentLockError).reason).toBe("lost");
  });

  it("切换多人协作后不再需要锁；关回去又可获取", async () => {
    const { owner, student, documentId } = await scene();
    await acquireLock(documentId, owner.id, OWNER_SESSION);

    await setCollaboration(documentId, owner.id, true);
    expect(await getLockView(documentId)).toBeNull();
    await expect(
      acquireLock(documentId, student.id, STUDENT_SESSION),
    ).rejects.toMatchObject({ reason: "collaboration_enabled" });

    // 协作模式下保存无需锁
    await expect(
      saveDocument({
        documentId,
        userId: student.id,
        sessionId: STUDENT_SESSION,
        baseVersion: 1,
        bytes: Buffer.from("协作保存"),
        mimeType: "text/plain",
      }),
    ).resolves.toMatchObject({ version: 2 });

    await setCollaboration(documentId, owner.id, false);
    const lock = await acquireLock(documentId, student.id, STUDENT_SESSION);
    expect(lock?.userId).toBe(student.id);
  });
});
