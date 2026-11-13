import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { documentEditors, documents } from "@/db/schema";
import { getDocumentAccess } from "@/lib/documents/access";
import { ensureDocument } from "@/lib/documents/service";
import {
  __resetDocumentBusForTests,
  subscribe,
} from "@/lib/documents/events";
import type { DocumentEvent } from "@/lib/documents/types";
import { resetDb } from "./helpers";
import {
  addTextAttachment,
  makeDocScene,
  setupTempUploadDir,
  teardownTempUploadDir,
} from "./documents-helpers";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  auth: async () =>
    authMock.userId
      ? { user: { id: authMock.userId, name: "测试用户" } }
      : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  grantEditorAction,
  revokeEditorAction,
  setCollaborationAction,
} from "@/app/(app)/documents/[documentId]/actions";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(async () => {
  await resetDb();
  revalidateMock.mockClear();
  __resetDocumentBusForTests();
});

async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const { document } = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: document.id };
}

function collect(documentId: string): DocumentEvent[] {
  const events: DocumentEvent[] = [];
  subscribe(documentId, {
    id: "test-sub",
    userId: "test-sub",
    name: "订阅者",
    send: (event) => events.push(event),
    close: () => {},
  });
  return events;
}

describe("文档设置类 Server Actions", () => {
  it("未登录 / 参数错误", async () => {
    const { owner, documentId } = await scene();
    authMock.userId = null;
    expect(await setCollaborationAction(documentId, true)).toEqual({ error: "请先登录" });

    authMock.userId = owner.id;
    expect(await setCollaborationAction("bad", true)).toEqual({ error: "参数不正确" });
    expect(await grantEditorAction(documentId, "bad")).toEqual({ error: "参数不正确" });
  });

  it("开启/关闭多人协作：写库、revalidate、广播 settings + lock", async () => {
    const { owner, documentId } = await scene();
    authMock.userId = owner.id;
    const events = collect(documentId);

    expect(await setCollaborationAction(documentId, true)).toEqual({ ok: true });
    const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(doc.collaborationEnabled).toBe(true);
    expect(revalidateMock).toHaveBeenCalledWith(`/documents/${documentId}`);
    expect(events).toContainEqual({
      type: "settings",
      collaborationEnabled: true,
      actorId: owner.id,
    });
    expect(events).toContainEqual({ type: "lock", lock: null });

    expect(await setCollaborationAction(documentId, false)).toEqual({ ok: true });
    const [after] = await db.select().from(documents).where(eq(documents.id, documentId));
    expect(after.collaborationEnabled).toBe(false);
  });

  it("只读 teacher 不能切换协作/授权", async () => {
    const { teacher, student, documentId } = await scene();
    authMock.userId = teacher.id;
    expect(await setCollaborationAction(documentId, true)).toMatchObject({
      error: expect.stringContaining("管理"),
    });
    expect(await grantEditorAction(documentId, student.id)).toMatchObject({
      error: expect.stringContaining("管理"),
    });
  });

  it("授予 / 撤销编辑权：立即生效并广播 permission", async () => {
    const { owner, teacher, documentId } = await scene();
    authMock.userId = owner.id;
    const events = collect(documentId);

    expect(await grantEditorAction(documentId, teacher.id)).toEqual({ ok: true });
    expect(events).toContainEqual({
      type: "permission",
      userId: teacher.id,
      canEdit: true,
    });
    expect((await getDocumentAccess(documentId, teacher.id))?.canEdit).toBe(true);
    expect(
      await db
        .select()
        .from(documentEditors)
        .where(eq(documentEditors.documentId, documentId)),
    ).toHaveLength(1);

    expect(await revokeEditorAction(documentId, teacher.id)).toEqual({ ok: true });
    expect(events).toContainEqual({
      type: "permission",
      userId: teacher.id,
      canEdit: false,
    });
    expect((await getDocumentAccess(documentId, teacher.id))?.canEdit).toBe(false);
    expect(
      await db
        .select()
        .from(documentEditors)
        .where(eq(documentEditors.documentId, documentId)),
    ).toHaveLength(0);
  });

  it("授权目标必须是团队成员", async () => {
    const { owner, outsider, documentId } = await scene();
    authMock.userId = owner.id;
    expect(await grantEditorAction(documentId, outsider.id)).toMatchObject({
      error: expect.stringContaining("不是该团队成员"),
    });
  });

  it("授权上传者/自己本身无需落行（幂等）", async () => {
    const { owner, student, documentId } = await scene();
    authMock.userId = owner.id;
    expect(await grantEditorAction(documentId, owner.id)).toEqual({ ok: true });
    expect(await grantEditorAction(documentId, student.id)).toEqual({ ok: true });
    expect(
      await db
        .select()
        .from(documentEditors)
        .where(eq(documentEditors.documentId, documentId)),
    ).toHaveLength(0);
  });
});
