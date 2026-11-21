import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { db } from "@/db";
import { libraries } from "@/db/schema";
import {
  createLibraryFolder,
  deleteLibraryFolder,
  ensureLibrary,
  listLibraryContents,
  renameLibraryFolder,
} from "@/lib/library/folders";
import { moveLibraryItem, renameLibraryItem } from "@/lib/library/versions";
import { syncPersonalLibrary } from "@/lib/library/sync";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

describe("资源库模型", () => {
  it("个人库与团队库幂等创建，并带默认文件夹", async () => {
    const s = await makeDocScene();
    const personalRef = { kind: "personal" as const, userId: s.student.id };
    const a = await ensureLibrary(personalRef);
    const b = await ensureLibrary(personalRef);
    expect(a.id).toBe(b.id);
    expect(await db.select().from(libraries)).toHaveLength(1);

    const root = await listLibraryContents(s.student.id, personalRef);
    expect(root.folders.map((f) => f.name).sort()).toEqual(
      ["任务附件", "助手生成", "手动上传", "群聊", "私信"].sort(),
    );
    expect(root.folders.every((f) => f.isDefault)).toBe(true);

    const teamRef = { kind: "team" as const, teamId: s.team.id };
    const t1 = await ensureLibrary(teamRef);
    const t2 = await ensureLibrary(teamRef);
    expect(t1.id).toBe(t2.id);
    const teamRoot = await listLibraryContents(s.owner.id, teamRef);
    expect(teamRoot.folders.map((f) => f.name).sort()).toEqual(
      ["任务附件", "手动上传", "群文件"].sort(),
    );
  });

  it("文件夹支持新建/改名/删除，同级重名与默认夹受限", async () => {
    const s = await makeDocScene();
    const ref = { kind: "personal" as const, userId: s.student.id };
    const folder = await createLibraryFolder(s.student.id, ref, null, "资料");
    await expect(
      createLibraryFolder(s.student.id, ref, null, "资料"),
    ).rejects.toThrow("同名文件夹");
    await renameLibraryFolder(s.student.id, folder.id, "资料二");
    const root = await listLibraryContents(s.student.id, ref);
    expect(root.folders.some((f) => f.name === "资料二")).toBe(true);

    const defaultFolder = root.folders.find((f) => f.name === "任务附件")!;
    await expect(
      renameLibraryFolder(s.student.id, defaultFolder.id, "改不了"),
    ).rejects.toThrow("默认文件夹");
    await expect(deleteLibraryFolder(s.student.id, defaultFolder.id)).rejects.toThrow(
      "默认文件夹",
    );

    await deleteLibraryFolder(s.student.id, folder.id);
    const after = await listLibraryContents(s.student.id, ref);
    expect(after.folders.some((f) => f.name === "资料二")).toBe(false);
  });

  it("重命名/移动遇到同名文件会被拒绝", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "A.txt", "a");
    await addTextAttachment(s.student.id, s.task.id, "B.txt", "b");
    await syncPersonalLibrary(s.student.id, { force: true });
    const ref = { kind: "personal" as const, userId: s.student.id };
    const root = await listLibraryContents(s.student.id, ref);
    const taskFolder = root.folders.find((f) => f.name === "任务附件")!;
    const view = await listLibraryContents(s.student.id, ref, taskFolder.id);
    const a = view.items.find((i) => i.filename === "A.txt")!;
    const b = view.items.find((i) => i.filename === "B.txt")!;

    await expect(renameLibraryItem(s.student.id, a.id, "b.TXT")).rejects.toThrow(
      "同名文件",
    );
    const target = await createLibraryFolder(s.student.id, ref, null, "归档");
    await moveLibraryItem(s.student.id, a.id, target.id);
    const archived = await listLibraryContents(s.student.id, ref, target.id);
    expect(archived.items.map((i) => i.filename)).toEqual(["A.txt"]);
    expect(b.id).toBeTruthy();
  });
});
