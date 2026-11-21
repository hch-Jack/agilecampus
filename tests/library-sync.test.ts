import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { libraryItems, libraryVersions } from "@/db/schema";
import { readBlob } from "@/lib/blob-store";
import { getLibraryFileRef } from "@/lib/library/content";
import { ensureLibrary, listLibraryContents } from "@/lib/library/folders";
import { syncPersonalLibrary, syncTeamLibrary } from "@/lib/library/sync";
import { listItemVersions } from "@/lib/library/versions";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import {
  addAgentFile,
  addDmFile,
  addLegacyTaskAttachment,
} from "./library-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

async function folderIdByName(
  actorId: string,
  ref: Parameters<typeof ensureLibrary>[0],
  name: string,
) {
  await ensureLibrary(ref);
  const view = await listLibraryContents(actorId, ref);
  const folder = view.folders.find((f) => f.name === name);
  expect(folder, `folder ${name}`).toBeTruthy();
  return folder!.id;
}

describe("资源库自动汇总", () => {
  it("个人库汇总我上传的任务附件、收发私信与助手文件", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "计划.md", "第一版");
    await addDmFile(s.student.id, s.owner.id, "发出的私信.txt", "a");
    await addDmFile(s.owner.id, s.student.id, "收到的私信.txt", "b");
    await addAgentFile(s.student.id, "助手.txt", "c");

    await syncPersonalLibrary(s.student.id, { force: true });

    const ref = { kind: "personal" as const, userId: s.student.id };
    const root = await listLibraryContents(s.student.id, ref);
    expect(root.folders.map((f) => f.name)).toEqual(
      expect.arrayContaining(["任务附件", "私信", "群聊", "助手生成", "手动上传"]),
    );

    const taskFolder = root.folders.find((f) => f.name === "任务附件")!;
    const taskView = await listLibraryContents(s.student.id, ref, taskFolder.id);
    expect(taskView.items.map((i) => i.filename)).toEqual(["计划.md"]);
    expect(taskView.items[0].origin).toBe("task");

    const dmFolder = root.folders.find((f) => f.name === "私信")!;
    const dmView = await listLibraryContents(s.student.id, ref, dmFolder.id);
    expect(dmView.items.map((i) => i.filename).sort()).toEqual([
      "发出的私信.txt",
      "收到的私信.txt",
    ]);

    const agentFolder = root.folders.find((f) => f.name === "助手生成")!;
    const agentView = await listLibraryContents(s.student.id, ref, agentFolder.id);
    expect(agentView.items.map((i) => i.filename)).toEqual(["助手.txt"]);
  });

  it("团队库汇总团队全部任务附件，教师也能查看", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "学生文件.txt", "student");
    await addTextAttachment(s.owner.id, s.task.id, "负责人文件.txt", "owner");

    await syncTeamLibrary(s.teacher.id, s.team.id, { force: true });
    const ref = { kind: "team" as const, teamId: s.team.id };
    const folder = await folderIdByName(s.teacher.id, ref, "任务附件");
    const view = await listLibraryContents(s.teacher.id, ref, folder);
    expect(view.items.map((i) => i.filename).sort()).toEqual([
      "学生文件.txt",
      "负责人文件.txt",
    ]);
    expect(view.canEdit).toBe(false);
  });

  it("同名文件合并为一项并保留两个版本；重复同步幂等", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "方案.md", "v1");
    await addTextAttachment(s.student.id, s.task.id, "方案.md", "v2");

    const ref = { kind: "personal" as const, userId: s.student.id };
    await syncPersonalLibrary(s.student.id, { force: true });
    const folder = await folderIdByName(s.student.id, ref, "任务附件");
    let view = await listLibraryContents(s.student.id, ref, folder);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].filename).toBe("方案.md");
    expect(view.items[0].versionCount).toBe(2);

    const itemId = view.items[0].id;
    expect(await listItemVersions(itemId)).toHaveLength(2);

    await syncPersonalLibrary(s.student.id, { force: true });
    view = await listLibraryContents(s.student.id, ref, folder);
    expect(view.items[0].versionCount).toBe(2);
  });

  it("并发同步不会重复建条目或版本", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "并发.txt", "v1");
    const ref = { kind: "personal" as const, userId: s.student.id };

    await Promise.all([
      syncPersonalLibrary(s.student.id, { force: true }),
      syncPersonalLibrary(s.student.id, { force: true }),
    ]);

    const folder = await folderIdByName(s.student.id, ref, "任务附件");
    const view = await listLibraryContents(s.student.id, ref, folder);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].versionCount).toBe(1);
    expect(await listItemVersions(view.items[0].id)).toHaveLength(1);
  });

  it("老 bytea 附件会物化成磁盘 blob，内容可读", async () => {
    const s = await makeDocScene();
    await addLegacyTaskAttachment(s.task.id, s.student.id, "老附件.txt", "老内容");

    const ref = { kind: "personal" as const, userId: s.student.id };
    await syncPersonalLibrary(s.student.id, { force: true });
    const folder = await folderIdByName(s.student.id, ref, "任务附件");
    const view = await listLibraryContents(s.student.id, ref, folder);
    const itemId = view.items[0].id;

    const [item] = await db
      .select()
      .from(libraryItems)
      .where(eq(libraryItems.id, itemId));
    expect(item.currentStorageKey).toMatch(/^[0-9a-f]{2}\//);
    const refFile = await getLibraryFileRef(s.student.id, itemId);
    expect((await readBlob(refFile.storageKey)).toString("utf8")).toBe("老内容");
    expect(await db.select().from(libraryVersions)).toHaveLength(1);
  });
});
