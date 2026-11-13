import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  __resetDocumentBusForTests,
  broadcast,
  presence,
} from "@/lib/documents/events";
import { ensureDocument } from "@/lib/documents/service";
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

import { GET as eventsRoute } from "@/app/api/documents/[documentId]/events/route";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(async () => {
  await resetDb();
  __resetDocumentBusForTests();
});

const ctx = (documentId: string) => ({ params: Promise.resolve({ documentId }) });

async function scene() {
  const s = await makeDocScene();
  const attachment = await addTextAttachment(s.student.id, s.task.id);
  const { document } = await ensureDocument(s.owner.id, "task_attachment", attachment.id);
  return { ...s, documentId: document.id };
}

function sseRequest(url: string, signal?: AbortSignal) {
  return new Request(`http://test${url}`, { signal });
}

function decode(value: Uint8Array | undefined): string {
  return value ? new TextDecoder().decode(value) : "";
}

describe("GET /api/documents/[documentId]/events", () => {
  it("未登录 401，非法 uuid / 非成员 404", async () => {
    const { owner, outsider, documentId } = await scene();
    const url = `/api/documents/${documentId}/events`;

    authMock.userId = null;
    expect((await eventsRoute(sseRequest(url), ctx(documentId))).status).toBe(401);

    authMock.userId = owner.id;
    expect((await eventsRoute(sseRequest("/api/documents/abc/events"), ctx("abc"))).status).toBe(
      404,
    );

    authMock.userId = outsider.id;
    expect((await eventsRoute(sseRequest(url), ctx(documentId))).status).toBe(404);
  });

  it("返回 text/event-stream，首帧 hello 带版本/协作/在线成员", async () => {
    const { owner, documentId } = await scene();
    authMock.userId = owner.id;

    const res = await eventsRoute(
      sseRequest(`/api/documents/${documentId}/events`),
      ctx(documentId),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-cache");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    const first = decode((await reader.read()).value);
    expect(first).toContain("event: hello");
    const dataLine = first.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const hello = JSON.parse(dataLine!.slice("data: ".length));
    expect(hello).toMatchObject({
      type: "hello",
      version: 1,
      collaborationEnabled: false,
      lock: null,
    });
    expect(hello.users).toEqual([{ userId: owner.id, name: "测试用户" }]);
    expect(presence(documentId)).toEqual([{ userId: owner.id, name: "测试用户" }]);

    await reader.cancel();
  });

  it("后续事件按 SSE 帧推送", async () => {
    const { owner, student, documentId } = await scene();
    authMock.userId = owner.id;

    const res = await eventsRoute(
      sseRequest(`/api/documents/${documentId}/events`),
      ctx(documentId),
    );
    const reader = res.body!.getReader();
    await reader.read(); // hello
    await reader.read(); // presence

    broadcast(documentId, {
      type: "saved",
      version: 2,
      actorId: student.id,
      actorName: "student",
      savedAt: "2026-01-01T00:00:00.000Z",
      note: "manual",
    });
    const chunk = decode((await reader.read()).value);
    expect(chunk).toContain("event: saved");
    expect(chunk).toContain('"version":2');

    await reader.cancel();
  });

  it("断开后从在线名单中移除", async () => {
    const { owner, documentId } = await scene();
    authMock.userId = owner.id;

    const controller = new AbortController();
    const res = await eventsRoute(
      sseRequest(`/api/documents/${documentId}/events`, controller.signal),
      ctx(documentId),
    );
    const reader = res.body!.getReader();
    await reader.read();
    expect(presence(documentId)).toHaveLength(1);

    controller.abort();
    expect(presence(documentId)).toEqual([]);

    // 流已被清理，读取要么 done、要么立即结束
    await reader.cancel().catch(() => {});
  });
});
