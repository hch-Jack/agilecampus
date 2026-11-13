import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { db } from "@/db";
import { documents } from "@/db/schema";
import { ForbiddenError } from "@/lib/errors";
import {
  getDocumentAccess,
  requireDocumentEdit,
  requireDocumentManage,
} from "@/lib/documents/access";
import { ensureDocument, grantEditor, revokeEditor } from "@/lib/documents/service";
import { uploadAttachment } from "@/lib/attachment";
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

/** 学生上传的文本附件 + 已建的文档行（owner 打开建档） */
async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const access = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: access.document.id };
}

describe("文档访问判定：canEdit / canManage / editVia", () => {
  it("上传者：owner，可编辑可管理", async () => {
    const { student, documentId } = await scene();
    const access = await getDocumentAccess(documentId, student.id);
    expect(access).not.toBeNull();
    expect(access?.canEdit).toBe(true);
    expect(access?.canManage).toBe(true);
    expect(access?.editVia).toBe("owner");
  });

  it("团队 admin（非上传者）：admin，可编辑可管理", async () => {
    const { owner, documentId } = await scene();
    const access = await getDocumentAccess(documentId, owner.id);
    expect(access?.canEdit).toBe(true);
    expect(access?.canManage).toBe(true);
    expect(access?.editVia).toBe("admin");
    expect(access?.role).toBe("admin");
  });

  it("teacher 默认只读：能读，不可编辑/管理", async () => {
    const { teacher, documentId } = await scene();
    const access = await getDocumentAccess(documentId, teacher.id);
    expect(access).not.toBeNull();
    expect(access?.canEdit).toBe(false);
    expect(access?.canManage).toBe(false);
    expect(access?.editVia).toBeNull();
    expect(access?.role).toBe("teacher");
  });

  it("被显式授权的 teacher：grant 可编辑，仍不可管理", async () => {
    const { owner, teacher, documentId } = await scene();
    await grantEditor(documentId, owner.id, teacher.id);

    const access = await getDocumentAccess(documentId, teacher.id);
    expect(access?.canEdit).toBe(true);
    expect(access?.canManage).toBe(false);
    expect(access?.editVia).toBe("grant");
  });

  it("撤销授权后立即回到只读", async () => {
    const { owner, teacher, documentId } = await scene();
    await grantEditor(documentId, owner.id, teacher.id);
    await revokeEditor(documentId, owner.id, teacher.id);

    const access = await getDocumentAccess(documentId, teacher.id);
    expect(access?.canEdit).toBe(false);
    expect(access?.editVia).toBeNull();
  });

  it("非团队成员：读不到（不泄露存在性）", async () => {
    const { outsider, documentId } = await scene();
    expect(await getDocumentAccess(documentId, outsider.id)).toBeNull();
    await expect(requireDocumentEdit(documentId, outsider.id)).rejects.toThrow(ForbiddenError);
  });

  it("requireDocumentEdit / requireDocumentManage 拒绝只读 teacher", async () => {
    const { teacher, documentId } = await scene();
    await expect(requireDocumentEdit(documentId, teacher.id)).rejects.toThrow("编辑权限");
    await expect(requireDocumentManage(documentId, teacher.id)).rejects.toThrow("管理");
  });
});

describe("ensureDocument：来源与格式门槛", () => {
  it("未知来源类型被拒", async () => {
    const { owner } = await makeDocScene();
    await expect(
      ensureDocument(owner.id, "resource_library", "whatever"),
    ).rejects.toThrow("不支持的文档来源");
  });

  it("未注册来源的历史文档行读不到（总资源库接入前的占位行为）", async () => {
    const { owner } = await makeDocScene();
    const [row] = await db
      .insert(documents)
      .values({
        sourceType: "resource_library",
        sourceId: "future-resource",
        format: "text",
        filename: "future.txt",
        createdById: owner.id,
      })
      .returning({ id: documents.id });
    expect(await getDocumentAccess(row.id, owner.id)).toBeNull();
  });

  it("不可编辑格式（PDF）不建档", async () => {
    const { owner, task } = await makeDocScene();
    const pdf = await uploadAttachment(owner.id, task.id, {
      filename: "scan.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4"),
    });
    await expect(ensureDocument(owner.id, "task_attachment", pdf.id)).rejects.toThrow(
      "不支持在线编辑",
    );
    expect(await db.select().from(documents)).toHaveLength(0);
  });

  it("超限文本直接只读", async () => {
    const { owner, task } = await makeDocScene();
    const big = await uploadAttachment(owner.id, task.id, {
      filename: "big.txt",
      mimeType: "text/plain",
      data: Buffer.alloc(2 * 1024 * 1024 + 1, 65),
    });
    await expect(ensureDocument(owner.id, "task_attachment", big.id)).rejects.toThrow(
      "不支持在线编辑",
    );
  });
});
