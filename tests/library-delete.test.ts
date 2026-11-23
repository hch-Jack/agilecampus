import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agentFiles, dmAttachments, libraryItems, libraryVersions, taskAttachments } from "@/db/schema";
import { deleteAgentFile } from "@/lib/agent/files";
import { readBlob } from "@/lib/blob-store";
import { getLibraryFileRef } from "@/lib/library/content";
import { listLibraryContents } from "@/lib/library/folders";
import { syncPersonalLibrary } from "@/lib/library/sync";
import { deleteLibraryItem, deleteLibraryVersion, listItemVersions } from "@/lib/library/versions";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import { addAgentFile, addDmFile } from "./library-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

async function personalFolder(actorId: string, name: string) {
  const ref = { kind: "personal" as const, userId: actorId };
  const root = await listLibraryContents(actorId, ref);
  return { ref, folderId: root.folders.find((f) => f.name === name)!.id };
}

describe("资源库删除", () => {
  it("可以删除单个历史版本，当前版本不能删", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "版本测试.txt", "v1");
    await addTextAttachment(s.student.id, s.task.id, "版本测试.txt", "v2");
    await syncPersonalLibrary(s.student.id, { force: true });

    const { ref, folderId } = await personalFolder(s.student.id, "任务附件");
    const view = await listLibraryContents(s.student.id, ref, folderId);
    const itemId = view.items[0].id;
    expect(await listItemVersions(itemId)).toHaveLength(2);

    await expect(deleteLibraryVersion(s.student.id, itemId, 2)).rejects.toThrow("当前版本不能删除");
    await deleteLibraryVersion(s.student.id, itemId, 1);
    expect((await listItemVersions(itemId)).map((v) => v.version)).toEqual([2]);
  });

  it("仅删除资源库记录不会删除来源；勾选连带来源才删除任务附件/助手文件", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "任务文件.txt", "task");
    const agent = await addAgentFile(s.student.id, "助手文件.txt", "agent");
    const dm = await addDmFile(s.student.id, s.owner.id, "私信文件.txt", "dm");
    await syncPersonalLibrary(s.student.id, { force: true });

    const taskFolder = await personalFolder(s.student.id, "任务附件");
    const taskView = await listLibraryContents(s.student.id, taskFolder.ref, taskFolder.folderId);
    await deleteLibraryItem(s.student.id, taskView.items[0].id);
    expect(await db.select().from(taskAttachments)).toHaveLength(1);

    const agentFolder = await personalFolder(s.student.id, "助手生成");
    const agentView = await listLibraryContents(s.student.id, agentFolder.ref, agentFolder.folderId);
    const res1 = await deleteLibraryItem(s.student.id, agentView.items[0].id, {
      deleteSources: true,
    });
    expect(res1.deletedSources).toHaveLength(1);
    expect(
      await db.select().from(agentFiles).where(eq(agentFiles.id, agent.id)),
    ).toHaveLength(0);

    const dmFolder = await personalFolder(s.student.id, "私信");
    const dmView = await listLibraryContents(s.student.id, dmFolder.ref, dmFolder.folderId);
    const dmItem = dmView.items.find((i) => i.filename === "私信文件.txt")!;
    const res2 = await deleteLibraryItem(s.student.id, dmItem.id, { deleteSources: true });
    expect(res2.skippedSources).toHaveLength(1);
    expect(
      await db.select().from(dmAttachments).where(eq(dmAttachments.id, dm.attachment.id)),
    ).toHaveLength(1);
  });

  it("删除助手源文件不会误删资源库仍在引用的 blob", async () => {
    const s = await makeDocScene();
    const agent = await addAgentFile(s.student.id, "共享 blob.txt", "shared");
    await syncPersonalLibrary(s.student.id, { force: true });

    const folder = await personalFolder(s.student.id, "助手生成");
    const view = await listLibraryContents(s.student.id, folder.ref, folder.folderId);
    const itemId = view.items[0].id;

    await deleteAgentFile(s.student.id, agent.id);
    expect(await db.select().from(agentFiles)).toHaveLength(0);
    // 资源库仍能读出内容
    const refFile = await getLibraryFileRef(s.student.id, itemId);
    expect((await readBlob(refFile.storageKey)).toString("utf8")).toBe("shared");
    const [item] = await db.select().from(libraryItems).where(eq(libraryItems.id, itemId));
    expect(item).toBeTruthy();
    expect(await db.select().from(libraryVersions)).toHaveLength(1);
  });
});
