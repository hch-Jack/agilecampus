import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { libraryOperations, librarySourceLinks } from "@/db/schema";
import { readBlob } from "@/lib/blob-store";
import { acquireLock } from "@/lib/documents/locks";
import { ensureDocument, saveDocument } from "@/lib/documents/service";
import { getLibraryFileRef } from "@/lib/library/content";
import { ensureLibrary, listLibraryContents } from "@/lib/library/folders";
import { syncGroupFileToLibrary } from "@/lib/group-files";
import { syncPersonalLibrary, syncTeamLibrary } from "@/lib/library/sync";
import { listItemVersions } from "@/lib/library/versions";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import { addGroupFile, makeGroupWithFiles } from "./library-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const SESSION = "session-owner-0001";
const SESSION2 = "session-student-0001";

async function taskFolder(actorId: string, ref: { kind: "team"; teamId: string }) {
  await ensureLibrary(ref);
  const root = await listLibraryContents(actorId, ref);
  return root.folders.find((f) => f.name === "任务附件")!.id;
}

describe("live 跟随任务附件的在线编辑", () => {
  it("任务附件保存新版本后，资源库同步会追加同样的版本", async () => {
    const s = await makeDocScene();
    const attachment = await addTextAttachment(s.student.id, s.task.id, "跟随.txt", "v1");
    const ref = { kind: "team" as const, teamId: s.team.id };

    await syncTeamLibrary(s.owner.id, ref.teamId, { force: true });
    const folder = await taskFolder(s.owner.id, ref);
    let view = await listLibraryContents(s.owner.id, ref, folder);
    expect(view.items[0].versionCount).toBe(1);

    const doc = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
    await acquireLock(doc.document.id, s.owner.id, SESSION);
    await saveDocument({
      documentId: doc.document.id,
      userId: s.owner.id,
      sessionId: SESSION,
      baseVersion: 1,
      bytes: Buffer.from("v2", "utf8"),
      mimeType: "text/plain",
      note: "manual",
    });

    await syncTeamLibrary(s.owner.id, ref.teamId, { force: true });
    view = await listLibraryContents(s.owner.id, ref, folder);
    expect(view.items[0].versionCount).toBe(2);
    expect(view.items[0].currentVersion).toBe(2);

    const versions = await listItemVersions(view.items[0].id);
    expect(versions[0].version).toBe(2);
    const refFile = await getLibraryFileRef(s.owner.id, view.items[0].id);
    expect((await readBlob(refFile.storageKey)).toString("utf8")).toBe("v2");
  });

  it("直接在线编辑资源库文件会停止跟随来源，并留下操作日志", async () => {
    const s = await makeDocScene();
    const attachment = await addTextAttachment(s.student.id, s.task.id, "停止跟随.txt", "v1");
    const ref = { kind: "team" as const, teamId: s.team.id };
    await syncTeamLibrary(s.owner.id, ref.teamId, { force: true });
    const folder = await taskFolder(s.owner.id, ref);
    const view = await listLibraryContents(s.owner.id, ref, folder);
    const itemId = view.items[0].id;

    const doc = await ensureDocument(s.student.id, "library_item", itemId);
    expect(doc.document.currentVersion).toBe(1);
    await acquireLock(doc.document.id, s.student.id, SESSION2);
    await saveDocument({
      documentId: doc.document.id,
      userId: s.student.id,
      sessionId: SESSION2,
      baseVersion: 1,
      bytes: Buffer.from("资源库内编辑", "utf8"),
      mimeType: "text/plain",
      note: "manual",
    });

    const [link] = await db
      .select()
      .from(librarySourceLinks)
      .where(
        and(
          eq(librarySourceLinks.sourceType, "task_attachment"),
          eq(librarySourceLinks.sourceId, attachment.id),
        ),
      );
    expect(link.mode).toBe("snapshot");

    const ops = await db
      .select()
      .from(libraryOperations)
      .where(eq(libraryOperations.itemId, itemId));
    expect(ops.map((o) => o.type)).toContain("live_follow_detached");
    expect((await listItemVersions(itemId))[0].version).toBe(2);
  });
});

describe("群文件快照/实时跟进", () => {
  it("snapshot 只保留首次同步的版本", async () => {
    const s = await makeDocScene();
    const { group, attachments } = await makeGroupWithFiles(s.owner.id, [s.student.id], [
      { senderId: s.owner.id, filename: "群方案.txt", content: "v1" },
    ]);
    const ref = { kind: "personal" as const, userId: s.student.id };

    await syncGroupFileToLibrary({
      actorId: s.student.id,
      groupId: group.id,
      attachmentId: attachments[0].attachmentId,
      target: ref,
      mode: "snapshot",
    });
    await addGroupFile(group.id, s.owner.id, "群方案.txt", "v2");
    await syncPersonalLibrary(s.student.id, { force: true });

    const root = await listLibraryContents(s.student.id, ref);
    const folder = root.folders.find((f) => f.name === "群聊")!.id;
    const view = await listLibraryContents(s.student.id, ref, folder);
    expect(view.items[0].versionCount).toBe(1);
  });

  it("live 会把同群同名新附件接续成新版本", async () => {
    const s = await makeDocScene();
    const { group, attachments } = await makeGroupWithFiles(s.owner.id, [s.student.id], [
      { senderId: s.owner.id, filename: "群方案.txt", content: "v1" },
    ]);
    const ref = { kind: "personal" as const, userId: s.student.id };

    await syncGroupFileToLibrary({
      actorId: s.student.id,
      groupId: group.id,
      attachmentId: attachments[0].attachmentId,
      target: ref,
      mode: "live",
    });
    await addGroupFile(group.id, s.owner.id, "群方案.txt", "v2");
    await syncPersonalLibrary(s.student.id, { force: true });

    const root = await listLibraryContents(s.student.id, ref);
    const folder = root.folders.find((f) => f.name === "群聊")!.id;
    const view = await listLibraryContents(s.student.id, ref, folder);
    expect(view.items[0].versionCount).toBe(2);
  });
});
