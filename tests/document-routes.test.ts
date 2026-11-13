import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import * as XLSX from "xlsx";
import { uploadAttachment } from "@/lib/attachment";
import {
  ensureDocument,
  setCollaboration,
} from "@/lib/documents/service";
import { acquireLock } from "@/lib/documents/locks";
import { assertSameOrigin } from "@/lib/documents/http";
import { SHEET_EDIT_MAX_BYTES } from "@/lib/documents/format";
import { resetDb } from "./helpers";
import {
  addTextAttachment,
  makeDocScene,
  setupTempUploadDir,
  teardownTempUploadDir,
} from "./documents-helpers";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () =>
    authMock.userId
      ? { user: { id: authMock.userId, name: "测试用户" } }
      : null,
}));

import { POST as openRoute } from "@/app/api/documents/open/route";
import { GET as stateRoute } from "@/app/api/documents/[documentId]/state/route";
import { GET as contentRoute } from "@/app/api/documents/[documentId]/content/route";
import {
  POST as saveRoute,
} from "@/app/api/documents/[documentId]/save/route";
import { POST as saveSheetRoute } from "@/app/api/documents/[documentId]/save-sheet/route";
import {
  POST as lockPost,
  PATCH as lockPatch,
  DELETE as lockDelete,
} from "@/app/api/documents/[documentId]/lock/route";
import { POST as restoreRoute } from "@/app/api/documents/[documentId]/restore/route";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const SESSION = "session-owner-0001";

const ctx = (documentId: string) => ({ params: Promise.resolve({ documentId }) });

function jsonReq(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://test${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function textScene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const { document } = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: document.id };
}

async function sheetScene() {
  const s = await makeDocScene();
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["名称", 1]]), "清单");
  const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const attachment = await uploadAttachment(s.owner.id, s.task.id, {
    filename: "统计.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    data: bytes,
  });
  const { document } = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, attachment, documentId: document.id, bytes };
}

describe("POST /api/documents/open", () => {
  it("未登录 401；参数错误 400", async () => {
    authMock.userId = null;
    const { owner, attachment } = await textScene();
    expect(
      (
        await openRoute(
          jsonReq("/api/documents/open", {
            sourceType: "task_attachment",
            sourceId: attachment.id,
          }),
        )
      ).status,
    ).toBe(401);

    authMock.userId = owner.id;
    expect((await openRoute(jsonReq("/api/documents/open", {}))).status).toBe(400);
  });

  it("成员打开返回 documentId/format/canEdit", async () => {
    const { student, attachment } = await textScene();
    authMock.userId = student.id;
    const res = await openRoute(
      jsonReq("/api/documents/open", {
        sourceType: "task_attachment",
        sourceId: attachment.id,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.documentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.format).toBe("text");
    expect(body.canEdit).toBe(true);
  });

  it("只读成员 canEdit=false；非成员 403；未知来源 400", async () => {
    const { teacher, outsider, attachment } = await textScene();

    authMock.userId = teacher.id;
    const teacherRes = await openRoute(
      jsonReq("/api/documents/open", {
        sourceType: "task_attachment",
        sourceId: attachment.id,
      }),
    );
    expect(teacherRes.status).toBe(200);
    expect((await teacherRes.json()).canEdit).toBe(false);

    authMock.userId = outsider.id;
    expect(
      (
        await openRoute(
          jsonReq("/api/documents/open", {
            sourceType: "task_attachment",
            sourceId: attachment.id,
          }),
        )
      ).status,
    ).toBe(403);

    authMock.userId = outsider.id;
    expect(
      (
        await openRoute(
          jsonReq("/api/documents/open", {
            sourceType: "resource_library",
            sourceId: "x",
          }),
        )
      ).status,
    ).toBe(400);
  });
});

describe("GET /api/documents/[documentId]/state 与 content", () => {
  it("state 返回编辑所需数据；非法 uuid 404", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;

    const res = await stateRoute(new Request("http://test/state"), ctx(documentId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.document.id).toBe(documentId);
    expect(body.contentUrl).toBe(`/api/documents/${documentId}/content`);
    expect(body.canEdit).toBe(true);
    expect(Array.isArray(body.versions)).toBe(true);

    expect(
      (await stateRoute(new Request("http://test/state"), ctx("not-a-uuid"))).status,
    ).toBe(404);
  });

  it("content 返回字节与 attachment 响应头；版本参数校验", async () => {
    const { owner, outsider, documentId } = await textScene();
    authMock.userId = owner.id;

    const res = await contentRoute(
      new Request(`http://test/api/documents/${documentId}/content`),
      ctx(documentId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(Buffer.from(await res.arrayBuffer()).toString("utf8")).toBe("第一版内容");

    const bad = await contentRoute(
      new Request(`http://test/api/documents/${documentId}/content?version=0`),
      ctx(documentId),
    );
    expect(bad.status).toBe(400);

    const missing = await contentRoute(
      new Request(`http://test/api/documents/${documentId}/content?version=9`),
      ctx(documentId),
    );
    expect(missing.status).toBe(400);

    authMock.userId = outsider.id;
    const forbidden = await contentRoute(
      new Request(`http://test/api/documents/${documentId}/content`),
      ctx(documentId),
    );
    expect(forbidden.status).toBe(403);
  });
});

describe("编辑锁接口", () => {
  it("获取 / 他人 423 / 续约 / 释放", async () => {
    const { owner, student, documentId } = await textScene();
    authMock.userId = owner.id;
    const url = `/api/documents/${documentId}/lock`;

    const acquired = await lockPost(jsonReq(url, { sessionId: SESSION }), ctx(documentId));
    expect(acquired.status).toBe(200);
    expect((await acquired.json()).lock.sessionId).toBe(SESSION);

    authMock.userId = student.id;
    const busy = await lockPost(
      jsonReq(url, { sessionId: "session-student-001" }),
      ctx(documentId),
    );
    expect(busy.status).toBe(423);
    expect((await busy.json()).code).toBe("LOCK_HELD");

    const lost = await lockPatch(
      jsonReq(url, { sessionId: "session-student-001" }),
      ctx(documentId),
    );
    expect(lost.status).toBe(409);
    expect((await lost.json()).code).toBe("LOCK_LOST");

    authMock.userId = owner.id;
    const renewed = await lockPatch(jsonReq(url, { sessionId: SESSION }), ctx(documentId));
    expect(renewed.status).toBe(200);

    const released = await lockDelete(
      new Request(`http://test${url}?sessionId=${SESSION}`, { method: "DELETE" }),
      ctx(documentId),
    );
    expect(released.status).toBe(204);
  });

  it("协作模式下获取锁返回 409 COLLABORATION_ENABLED", async () => {
    const { owner, documentId } = await textScene();
    await setCollaboration(documentId, owner.id, true);
    authMock.userId = owner.id;

    const res = await lockPost(
      jsonReq(`/api/documents/${documentId}/lock`, { sessionId: SESSION }),
      ctx(documentId),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("COLLABORATION_ENABLED");
  });

  it("sessionId 不合法 400", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;
    const res = await lockPost(
      jsonReq(`/api/documents/${documentId}/lock`, { sessionId: "short" }),
      ctx(documentId),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/documents/[documentId]/save", () => {
  it("文本保存成功；旧版本再次保存 409", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;
    await acquireLock(documentId, owner.id, SESSION);

    const res = await saveRoute(
      jsonReq(`/api/documents/${documentId}/save`, {
        baseVersion: 1,
        sessionId: SESSION,
        content: { kind: "text", text: "在线改过的内容" },
        note: "manual",
      }),
      ctx(documentId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(2);
    expect(body.size).toBe(Buffer.byteLength("在线改过的内容"));

    const conflict = await saveRoute(
      jsonReq(`/api/documents/${documentId}/save`, {
        baseVersion: 1,
        sessionId: SESSION,
        content: { kind: "text", text: "过期写入" },
      }),
      ctx(documentId),
    );
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "VERSION_CONFLICT",
      currentVersion: 2,
    });
  });

  it("未登录 401、参数错误 400、跨站 403、只读 403", async () => {
    const { owner, teacher, documentId } = await textScene();
    const payload = {
      baseVersion: 1,
      sessionId: SESSION,
      content: { kind: "text", text: "x" },
    };
    const url = `/api/documents/${documentId}/save`;

    authMock.userId = null;
    expect((await saveRoute(jsonReq(url, payload), ctx(documentId))).status).toBe(401);

    authMock.userId = owner.id;
    expect((await saveRoute(jsonReq(url, {}), ctx(documentId))).status).toBe(400);

    authMock.userId = teacher.id;
    expect((await saveRoute(jsonReq(url, payload), ctx(documentId))).status).toBe(403);
  });

  it("跨站写请求被拒", () => {
    const headers = new Headers({ origin: "http://evil.example", host: "test" });
    expect(() => assertSameOrigin({ headers } as Request)).toThrow("跨站请求被拒绝");
    expect(() =>
      assertSameOrigin({
        headers: new Headers({ origin: "http://test", host: "test" }),
      } as Request),
    ).not.toThrow();
  });

  it("文本接口拒绝 docx 文档；tiptap 接口拒绝文本文档", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;
    const res = await saveRoute(
      jsonReq(`/api/documents/${documentId}/save`, {
        baseVersion: 1,
        sessionId: SESSION,
        content: {
          kind: "tiptap",
          doc: { type: "doc", content: [{ type: "paragraph" }] },
        },
      }),
      ctx(documentId),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Word");
  });

  it("另存为返回 savedAs 与新 documentId", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;
    const res = await saveRoute(
      jsonReq(`/api/documents/${documentId}/save`, {
        baseVersion: 1,
        sessionId: SESSION,
        saveAsName: "副本.txt",
        content: { kind: "text", text: "副本内容" },
      }),
      ctx(documentId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.savedAs).toBe(true);
    expect(body.filename).toBe("副本.txt");
    expect(body.documentId).not.toBe(documentId);
  });

  it("超过 2MB 文本返回 413", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;
    const res = await saveRoute(
      jsonReq(`/api/documents/${documentId}/save`, {
        baseVersion: 1,
        sessionId: SESSION,
        content: { kind: "text", text: "a".repeat(2 * 1024 * 1024 + 1) },
      }),
      ctx(documentId),
    );
    expect(res.status).toBe(413);
  });
});

describe("POST /api/documents/[documentId]/save-sheet", () => {
  it("xlsx 字节保存成功；空字节 400；非表格文档 400", async () => {
    const { owner, task, documentId } = await sheetScene();
    authMock.userId = owner.id;
    await acquireLock(documentId, owner.id, SESSION);
    const url = `/api/documents/${documentId}/save-sheet?baseVersion=1&sessionId=${SESSION}`;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["名称", 2]]), "清单");
    const bytes = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const ok = await saveSheetRoute(
      new Request(`http://test${url}`, { method: "POST", body: bytes as unknown as BodyInit }),
      ctx(documentId),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).version).toBe(2);

    const empty = await saveSheetRoute(
      new Request(
        `http://test/api/documents/${documentId}/save-sheet?baseVersion=2&sessionId=${SESSION}`,
        { method: "POST", body: Buffer.alloc(0) as unknown as BodyInit },
      ),
      ctx(documentId),
    );
    expect(empty.status).toBe(400);
    expect((await empty.json()).error).toContain("空文件");

    // 同一场景下再挂一个文本文档，验证表格接口拒绝非表格格式
    const textAttachment = await uploadAttachment(owner.id, task.id, {
      filename: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("文本"),
    });
    const textDoc = await ensureDocument(owner.id, "task_attachment", textAttachment.id);
    authMock.userId = owner.id;
    const wrongFormat = await saveSheetRoute(
      new Request(
        `http://test/api/documents/${textDoc.document.id}/save-sheet?baseVersion=1&sessionId=${SESSION}`,
        { method: "POST", body: bytes as unknown as BodyInit },
      ),
      ctx(textDoc.document.id),
    );
    expect(wrongFormat.status).toBe(400);
    expect((await wrongFormat.json()).error).toContain("不是表格格式");
  });

  it("超过 10MB 返回 413", async () => {
    const { owner, documentId } = await sheetScene();
    authMock.userId = owner.id;
    const res = await saveSheetRoute(
      new Request(
        `http://test/api/documents/${documentId}/save-sheet?baseVersion=1&sessionId=${SESSION}`,
        {
          method: "POST",
          body: Buffer.alloc(SHEET_EDIT_MAX_BYTES + 1) as unknown as BodyInit,
        },
      ),
      ctx(documentId),
    );
    expect(res.status).toBe(413);
  });
});

describe("POST /api/documents/[documentId]/restore", () => {
  it("恢复历史版本成功；参数错误 400", async () => {
    const { owner, documentId } = await textScene();
    authMock.userId = owner.id;
    await acquireLock(documentId, owner.id, SESSION);

    await saveRoute(
      jsonReq(`/api/documents/${documentId}/save`, {
        baseVersion: 1,
        sessionId: SESSION,
        content: { kind: "text", text: "第二版" },
      }),
      ctx(documentId),
    );

    const res = await restoreRoute(
      jsonReq(`/api/documents/${documentId}/restore`, { version: 1, sessionId: SESSION }),
      ctx(documentId),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).version).toBe(3);

    const bad = await restoreRoute(
      jsonReq(`/api/documents/${documentId}/restore`, { version: 0, sessionId: SESSION }),
      ctx(documentId),
    );
    expect(bad.status).toBe(400);
  });
});
