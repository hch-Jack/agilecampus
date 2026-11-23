import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import { ensureDocument } from "@/lib/documents/service";
import { listLibraryContents } from "@/lib/library/folders";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () =>
    authMock.userId ? { user: { id: authMock.userId, name: "测试用户" } } : null,
}));

import { POST as saveAsLibraryRoute } from "@/app/api/documents/[documentId]/save-as-library/route";
import { POST as exportRoute } from "@/app/api/documents/[documentId]/export/route";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const ctx = (documentId: string) => ({ params: Promise.resolve({ documentId }) });

function jsonReq(url: string, body: unknown) {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function scene() {
  const s = await makeDocScene();
  const att = await addTextAttachment(s.student.id, s.task.id, "notes.txt", "原始");
  const doc = await ensureDocument(s.student.id, "task_attachment", att.id);
  return { ...s, documentId: doc.document.id };
}

describe("编辑器保存/导出路由", () => {
  it("另存为资源库文件：文本写入指定库与文件夹", async () => {
    const s = await scene();
    authMock.userId = s.student.id;
    const res = await saveAsLibraryRoute(
      jsonReq(`/api/documents/${s.documentId}/save-as-library`, {
        filename: "副本.txt",
        scope: "personal",
        content: { kind: "text", text: "另存内容" },
      }),
      ctx(s.documentId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.savedToLibrary).toBe(true);
    expect(body.version).toBe(1);

    const ref = { kind: "personal" as const, userId: s.student.id };
    const root = await listLibraryContents(s.student.id, ref);
    const manual = root.folders.find((f) => f.name === "手动上传")!;
    const view = await listLibraryContents(s.student.id, ref, manual.id);
    expect(view.items.map((i) => i.filename)).toContain("副本.txt");
  });

  it("下载副本不写入资源库", async () => {
    const s = await scene();
    authMock.userId = s.student.id;
    const res = await exportRoute(
      jsonReq(`/api/documents/${s.documentId}/export`, {
        filename: "导出.txt",
        content: { kind: "text", text: "导出内容" },
      }),
      ctx(s.documentId),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("导出内容");

    const ref = { kind: "personal" as const, userId: s.student.id };
    const root = await listLibraryContents(s.student.id, ref);
    expect(root.items).toHaveLength(0);
  });

  it("未登录 401，扩展名错误 400", async () => {
    const s = await scene();
    authMock.userId = null;
    const unauth = await saveAsLibraryRoute(
      jsonReq(`/api/documents/${s.documentId}/save-as-library`, {
        filename: "x.txt",
        scope: "personal",
        content: { kind: "text", text: "x" },
      }),
      ctx(s.documentId),
    );
    expect(unauth.status).toBe(401);

    authMock.userId = s.student.id;
    const bad = await saveAsLibraryRoute(
      jsonReq(`/api/documents/${s.documentId}/save-as-library`, {
        filename: "x.pdf",
        scope: "personal",
        content: { kind: "text", text: "x" },
      }),
      ctx(s.documentId),
    );
    expect(bad.status).toBe(400);
  });
});
