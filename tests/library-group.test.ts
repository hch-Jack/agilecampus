import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { librarySourceLinks } from "@/db/schema";
import { listGroupFiles, syncGroupFileToLibrary } from "@/lib/group-files";
import { listLibraryContents } from "@/lib/library/folders";
import { resetDb } from "./helpers";
import { makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import { makeGroupWithFiles } from "./library-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

async function groupFolder(actorId: string, ref: { kind: "personal"; userId: string } | { kind: "team"; teamId: string }, name: string) {
  const root = await listLibraryContents(actorId, ref);
  return root.folders.find((f) => f.name === name)!.id;
}

describe("群文件", () => {
  it("群成员可列出文件，非成员被拒", async () => {
    const s = await makeDocScene();
    const { group } = await makeGroupWithFiles(s.owner.id, [s.student.id], [
      { senderId: s.owner.id, filename: "方案.txt", content: "v1" },
    ]);
    const files = await listGroupFiles(s.student.id, group.id);
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("方案.txt");
    await expect(listGroupFiles(s.outsider.id, group.id)).rejects.toThrow("不是该群成员");
  });

  it("同步到个人库默认进「群聊」，重复同步幂等，可切换模式", async () => {
    const s = await makeDocScene();
    const { group, attachments } = await makeGroupWithFiles(s.owner.id, [s.student.id], [
      { senderId: s.owner.id, filename: "方案.txt", content: "v1" },
    ]);
    const ref = { kind: "personal" as const, userId: s.student.id };
    const first = await syncGroupFileToLibrary({
      actorId: s.student.id,
      groupId: group.id,
      attachmentId: attachments[0].attachmentId,
      target: ref,
      mode: "snapshot",
    });
    expect(first.created).toBe(true);

    const folder = await groupFolder(s.student.id, ref, "群聊");
    const view = await listLibraryContents(s.student.id, ref, folder);
    expect(view.items.map((i) => i.filename)).toEqual(["方案.txt"]);
    expect(view.items[0].versionCount).toBe(1);

    const second = await syncGroupFileToLibrary({
      actorId: s.student.id,
      groupId: group.id,
      attachmentId: attachments[0].attachmentId,
      target: ref,
      mode: "live",
    });
    expect(second.created).toBe(false);
    expect(second.itemId).toBe(first.itemId);
    expect(second.version).toBe(1);

    const [link] = await db
      .select()
      .from(librarySourceLinks)
      .where(eq(librarySourceLinks.itemId, first.itemId));
    expect(link.mode).toBe("live");
  });

  it("可以同步到团队库「群文件」；teacher 不能写入", async () => {
    const s = await makeDocScene();
    const { group, attachments } = await makeGroupWithFiles(s.owner.id, [s.student.id, s.teacher.id], [
      { senderId: s.owner.id, filename: "团队资料.txt", content: "v1" },
    ]);
    const teamRef = { kind: "team" as const, teamId: s.team.id };

    await expect(
      syncGroupFileToLibrary({
        actorId: s.teacher.id,
        groupId: group.id,
        attachmentId: attachments[0].attachmentId,
        target: teamRef,
        mode: "snapshot",
      }),
    ).rejects.toThrow("编辑权限");

    await syncGroupFileToLibrary({
      actorId: s.student.id,
      groupId: group.id,
      attachmentId: attachments[0].attachmentId,
      target: teamRef,
      mode: "snapshot",
    });
    const folder = await groupFolder(s.student.id, teamRef, "群文件");
    const view = await listLibraryContents(s.student.id, teamRef, folder);
    expect(view.items.map((i) => i.filename)).toEqual(["团队资料.txt"]);
  });
});
