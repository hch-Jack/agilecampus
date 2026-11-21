import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { db } from "@/db";
import { libraryItems } from "@/db/schema";
import { ensureDocument, grantEditor } from "@/lib/documents/service";
import { listLibraryContents } from "@/lib/library/folders";
import { saveDocumentBytesToLibrary } from "@/lib/library/save-as";
import { listItemVersions } from "@/lib/library/versions";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

describe("编辑器另存为资源库文件", () => {
  it("保存到个人/团队库的指定文件夹；同名再存会追加版本", async () => {
    const s = await makeDocScene();
    const att = await addTextAttachment(s.student.id, s.task.id, "notes.txt", "原始");
    const doc = await ensureDocument(s.student.id, "task_attachment", att.id);

    const personal = { kind: "personal" as const, userId: s.student.id };
    const root = await listLibraryContents(s.student.id, personal);
    const manual = root.folders.find((f) => f.name === "手动上传")!;

    const first = await saveDocumentBytesToLibrary({
      documentId: doc.document.id,
      userId: s.student.id,
      filename: "notes.txt",
      scope: "personal",
      folderId: manual.id,
      bytes: Buffer.from("副本一", "utf8"),
      mimeType: "text/plain",
    });

    const view = await listLibraryContents(s.student.id, personal, manual.id);
    expect(view.items.map((i) => i.filename)).toEqual(["notes.txt"]);
    expect(first.version).toBe(1);

    const second = await saveDocumentBytesToLibrary({
      documentId: doc.document.id,
      userId: s.student.id,
      filename: "notes.txt",
      scope: "personal",
      folderId: manual.id,
      bytes: Buffer.from("副本二", "utf8"),
      mimeType: "text/plain",
    });
    expect(second.itemId).toBe(first.itemId);
    expect(second.version).toBe(2);
    expect(await listItemVersions(first.itemId)).toHaveLength(2);
    expect(await db.select().from(libraryItems)).toHaveLength(1);
  });

  it("扩展名必须与原文件一致", async () => {
    const s = await makeDocScene();
    const att = await addTextAttachment(s.student.id, s.task.id, "notes.txt", "x");
    const doc = await ensureDocument(s.student.id, "task_attachment", att.id);
    await expect(
      saveDocumentBytesToLibrary({
        documentId: doc.document.id,
        userId: s.student.id,
        filename: "notes.pdf",
        scope: "personal",
        bytes: Buffer.from("x"),
        mimeType: "application/pdf",
      }),
    ).rejects.toThrow("扩展名");
  });

  it("teacher 即使被授予文档编辑权，也不能写入团队资源库", async () => {
    const s = await makeDocScene();
    const att = await addTextAttachment(s.owner.id, s.task.id, "团队.txt", "x");
    const doc = await ensureDocument(s.owner.id, "task_attachment", att.id);
    await grantEditor(doc.document.id, s.owner.id, s.teacher.id);

    await expect(
      saveDocumentBytesToLibrary({
        documentId: doc.document.id,
        userId: s.teacher.id,
        filename: "团队.txt",
        scope: "team",
        teamId: s.team.id,
        bytes: Buffer.from("x"),
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("编辑权限");
  });
});
