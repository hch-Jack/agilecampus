import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { listLibraryContents, createLibraryFolder } from "@/lib/library/folders";
import { moveLibraryItem } from "@/lib/library/versions";
import { syncPersonalLibrary } from "@/lib/library/sync";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const ref = (userId: string) => ({ kind: "personal" as const, userId });

async function seed() {
  const s = await makeDocScene();
  await addTextAttachment(s.student.id, s.task.id, "A.txt", "a");
  await addTextAttachment(s.student.id, s.task.id, "B.txt", "bbbbbbbbbb");
  await addTextAttachment(s.student.id, s.task.id, "报告.pdf", "x".repeat(200));
  await syncPersonalLibrary(s.student.id, { force: true });
  const root = await listLibraryContents(s.student.id, ref(s.student.id));
  const taskFolder = root.folders.find((f) => f.name === "任务附件")!;
  return { ...s, taskFolderId: taskFolder.id };
}

describe("资源库搜索 / 排序", () => {
  it("按文件名搜索当前文件夹及子文件夹，并显示所在路径", async () => {
    const s = await seed();
    const view = await listLibraryContents(s.student.id, ref(s.student.id), null, {
      q: "报告",
    });
    expect(view.searching).toBe(true);
    expect(view.items.map((i) => i.filename)).toEqual(["报告.pdf"]);
    expect(view.items[0].folderPath).toContain("任务附件");

    const scoped = await listLibraryContents(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
      { q: "报告" },
    );
    expect(scoped.items.map((i) => i.filename)).toEqual(["报告.pdf"]);
  });

  it("按文件类型筛选", async () => {
    const s = await seed();
    const pdf = await listLibraryContents(s.student.id, ref(s.student.id), null, {
      type: "pdf",
    });
    expect(pdf.items.map((i) => i.filename)).toEqual(["报告.pdf"]);

    const text = await listLibraryContents(s.student.id, ref(s.student.id), null, {
      type: "text",
    });
    expect(text.items.map((i) => i.filename).sort()).toEqual(["A.txt", "B.txt"]);
  });

  it("搜索会命中子文件夹里的文件，普通目录浏览不会", async () => {
    const s = await seed();
    const folder = await createLibraryFolder(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
      "归档",
    );
    const taskView = await listLibraryContents(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
    );
    const item = taskView.items.find((i) => i.filename === "A.txt")!;
    await moveLibraryItem(s.student.id, item.id, folder.id);

    const plain = await listLibraryContents(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
    );
    expect(plain.items.some((i) => i.filename === "A.txt")).toBe(false);

    const found = await listLibraryContents(s.student.id, ref(s.student.id), s.taskFolderId, {
      q: "A.txt",
    });
    expect(found.items.map((i) => i.filename)).toEqual(["A.txt"]);
    expect(found.items[0].folderPath).toContain("归档");
  });

  it("文件夹名也会出现在搜索结果中", async () => {
    const s = await seed();
    await createLibraryFolder(s.student.id, ref(s.student.id), null, "设计稿");
    const view = await listLibraryContents(s.student.id, ref(s.student.id), null, {
      q: "设计",
    });
    expect(view.folders.map((f) => f.name)).toEqual(["设计稿"]);
    expect(view.folders[0].path).toBe("设计稿");
  });

  it("按名称 / 大小 / 类型排序，文件夹始终排在文件前", async () => {
    const s = await seed();
    const asc = await listLibraryContents(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
      { sort: "name", dir: "asc" },
    );
    // zh-CN localeCompare 会把中文排在西文前
    expect(asc.items.map((i) => i.filename)).toEqual(["报告.pdf", "A.txt", "B.txt"]);

    const desc = await listLibraryContents(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
      { sort: "name", dir: "desc" },
    );
    expect(desc.items.map((i) => i.filename)).toEqual(["B.txt", "A.txt", "报告.pdf"]);

    const sizeDesc = await listLibraryContents(
      s.student.id,
      ref(s.student.id),
      s.taskFolderId,
      { sort: "size", dir: "desc" },
    );
    expect(sizeDesc.items.map((i) => i.filename)).toEqual(["报告.pdf", "B.txt", "A.txt"]);
  });
});
