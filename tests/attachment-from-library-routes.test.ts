import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { dmAttachments, taskAttachments } from "@/db/schema";
import { POST as taskFromLibrary } from "@/app/api/attachments/from-library/route";
import { POST as dmFromLibrary } from "@/app/api/dm/attachments/from-library/route";
import { uploadToLibrary } from "@/lib/library/upload";
import { resetDb } from "./helpers";
import {
  makeDocScene,
  setupTempUploadDir,
  teardownTempUploadDir,
} from "./documents-helpers";

// 两个路由都从 session 取身份；与其它 API 测试同一套 mock
const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () => (authMock.userId ? { user: { id: authMock.userId } } : null),
}));

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

function post(body: unknown, url: string) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function streamOf(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function seedPersonalLibraryFile(ownerId: string, filename: string, content: string) {
  const res = await uploadToLibrary(ownerId, { kind: "personal", userId: ownerId }, {
    folderId: null,
    filename,
    mimeType: "text/plain",
    stream: streamOf(content),
  });
  return res.itemId;
}

describe("资源库 → 任务附件 / 私信附件接口", () => {
  it("任务附件：复制一份到任务，资源库条目仍在", async () => {
    const s = await makeDocScene();
    const itemId = await seedPersonalLibraryFile(s.student.id, "资料.txt", "任务用资料");
    authMock.userId = s.student.id;

    const res = await taskFromLibrary(
      post({ itemId, taskId: s.task.id }, "http://test/api/attachments/from-library"),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; filename: string };
    expect(data.filename).toBe("资料.txt");

    const rows = await db
      .select()
      .from(taskAttachments)
      .where(eq(taskAttachments.taskId, s.task.id));
    expect(rows.map((r) => r.id)).toContain(data.id);
  });

  it("私信附件：预上传成未引用的 dm_attachments 行", async () => {
    const s = await makeDocScene();
    const itemId = await seedPersonalLibraryFile(s.student.id, "私信资料.txt", "私信用资料");
    authMock.userId = s.student.id;

    const res = await dmFromLibrary(
      post({ itemId }, "http://test/api/dm/attachments/from-library"),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: string; filename: string };
    expect(data.filename).toBe("私信资料.txt");

    const [row] = await db
      .select()
      .from(dmAttachments)
      .where(eq(dmAttachments.id, data.id));
    expect(row?.uploaderId).toBe(s.student.id);
  });

  it("无权读别人资源库的人两个入口都拒绝", async () => {
    const s = await makeDocScene();
    const itemId = await seedPersonalLibraryFile(s.student.id, "私有.txt", "私有");
    authMock.userId = s.outsider.id;

    const taskRes = await taskFromLibrary(
      post({ itemId, taskId: s.task.id }, "http://test/api/attachments/from-library"),
    );
    expect([403, 404]).toContain(taskRes.status);

    const dmRes = await dmFromLibrary(
      post({ itemId }, "http://test/api/dm/attachments/from-library"),
    );
    expect([403, 404]).toContain(dmRes.status);
  });
});
