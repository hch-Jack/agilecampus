import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { documents, libraryItems } from "@/db/schema";
import { readBlob } from "@/lib/blob-store";
import { acquireLock, releaseLock } from "@/lib/documents/locks";
import {
  ensureDocument,
  getDocumentState,
  saveDocument,
} from "@/lib/documents/service";
import { getLibraryFileRef } from "@/lib/library/content";
import { listLibraryContents } from "@/lib/library/folders";
import { restoreLibraryVersion } from "@/lib/library/restore";
import { syncTeamLibrary } from "@/lib/library/sync";
import { listItemVersions } from "@/lib/library/versions";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const SESSION = "session-student-0001";

async function sceneWithTeamItem() {
  const s = await makeDocScene();
  await addTextAttachment(s.student.id, s.task.id, "资源库文件.txt", "v1");
  const ref = { kind: "team" as const, teamId: s.team.id };
  await syncTeamLibrary(s.owner.id, ref.teamId, { force: true });
  const root = await listLibraryContents(s.owner.id, ref);
  const folder = root.folders.find((f) => f.name === "任务附件")!.id;
  const view = await listLibraryContents(s.owner.id, ref, folder);
  return { ...s, itemId: view.items[0].id };
}

describe("资源库条目的在线编辑", () => {
  it("打开时回填历史，保存后文档与资源库版本同号", async () => {
    const s = await sceneWithTeamItem();
    const access = await ensureDocument(s.student.id, "library_item", s.itemId);
    expect(access.canEdit).toBe(true);
    expect(access.document.currentVersion).toBe(1);

    await acquireLock(access.document.id, s.student.id, SESSION);
    const saved = await saveDocument({
      documentId: access.document.id,
      userId: s.student.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("v2", "utf8"),
      mimeType: "text/plain",
      note: "manual",
    });
    expect(saved.version).toBe(2);

    const [item] = await db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.id, s.itemId));
    expect(item.currentVersion).toBe(2);
    expect((await listItemVersions(s.itemId)).map((v) => v.version)).toEqual([2, 1]);

    const state = await getDocumentState(access.document.id, s.student.id);
    expect(state.versions.map((v) => v.version)).toEqual([2, 1]);

    const ref = await getLibraryFileRef(s.student.id, s.itemId);
    expect((await readBlob(ref.storageKey)).toString("utf8")).toBe("v2");
    await releaseLock(access.document.id, s.student.id, SESSION);
  });

  it("教师只读，即使旧文档授权也不能编辑资源库文件", async () => {
    const s = await sceneWithTeamItem();
    const access = await ensureDocument(s.teacher.id, "library_item", s.itemId);
    expect(access.canEdit).toBe(false);
    await expect(
      saveDocument({
        documentId: access.document.id,
        userId: s.teacher.id,
        sessionId: SESSION,
        baseVersion: 1,
        bytes: Buffer.from("x", "utf8"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("编辑权限");
  });

  it("预览窗恢复历史版本会同时推进资源库与文档版本", async () => {
    const s = await sceneWithTeamItem();
    const access = await ensureDocument(s.student.id, "library_item", s.itemId);
    await acquireLock(access.document.id, s.student.id, SESSION);
    await saveDocument({
      documentId: access.document.id,
      userId: s.student.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("v2", "utf8"),
      mimeType: "text/plain",
    });
    await releaseLock(access.document.id, s.student.id, SESSION);

    const restored = await restoreLibraryVersion({
      itemId: s.itemId,
      userId: s.student.id,
      version: 1,
    });
    expect(restored.version).toBe(3);

    const [item] = await db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.id, s.itemId));
    expect(item.currentVersion).toBe(3);
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, access.document.id));
    expect(doc.currentVersion).toBe(3);

    const ref = await getLibraryFileRef(s.student.id, s.itemId);
    expect((await readBlob(ref.storageKey)).toString("utf8")).toBe("v1");
    expect((await listItemVersions(s.itemId)).map((v) => v.version)).toEqual([3, 2, 1]);
  });
});
