import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import { syncPersonalLibrary } from "@/lib/library/sync";
import { listLibraryContents } from "@/lib/library/folders";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/lib/auth", () => ({
  auth: async () =>
    authMock.userId ? { user: { id: authMock.userId, name: "测试用户" } } : null,
}));

import { GET as itemRoute } from "@/app/api/library/items/[itemId]/route";
import { GET as contentRoute } from "@/app/api/library/items/[itemId]/content/route";
import { POST as restoreRoute } from "@/app/api/library/items/[itemId]/restore/route";
import { POST as uploadRoute } from "@/app/api/library/upload/route";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

const ctx = (itemId: string) => ({ params: Promise.resolve({ itemId }) });

async function sceneWithItem() {
  const s = await makeDocScene();
  await addTextAttachment(s.student.id, s.task.id, "路由测试.txt", "v1");
  await addTextAttachment(s.student.id, s.task.id, "路由测试.txt", "v2");
  await syncPersonalLibrary(s.student.id, { force: true });
  const ref = { kind: "personal" as const, userId: s.student.id };
  const root = await listLibraryContents(s.student.id, ref);
  const folder = root.folders.find((f) => f.name === "任务附件")!.id;
  const view = await listLibraryContents(s.student.id, ref, folder);
  return { ...s, itemId: view.items[0].id };
}

describe("资源库路由", () => {
  it("内容：当前/历史版本、401、404、非法版本", async () => {
    const s = await sceneWithItem();
    const url = `/api/library/items/${s.itemId}/content`;

    authMock.userId = null;
    expect((await contentRoute(new Request(`http://test${url}`), ctx(s.itemId))).status).toBe(401);

    authMock.userId = s.student.id;
    const current = await contentRoute(new Request(`http://test${url}`), ctx(s.itemId));
    expect(current.status).toBe(200);
    expect(await current.text()).toBe("v2");

    const v1 = await contentRoute(
      new Request(`http://test${url}?version=1`),
      ctx(s.itemId),
    );
    expect(v1.status).toBe(200);
    expect(await v1.text()).toBe("v1");

    expect(
      (await contentRoute(new Request(`http://test${url}?version=9`), ctx(s.itemId))).status,
    ).toBe(404);

    authMock.userId = s.outsider.id;
    expect(
      (await contentRoute(new Request(`http://test${url}`), ctx(s.itemId))).status,
    ).toBe(404);
  });

  it("条目详情返回版本/日志/权限", async () => {
    const s = await sceneWithItem();
    authMock.userId = s.student.id;
    const res = await itemRoute(
      new Request(`http://test/api/library/items/${s.itemId}`),
      ctx(s.itemId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.item.id).toBe(s.itemId);
    expect(body.permissions.canEdit).toBe(true);
    expect(body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(Array.isArray(body.operations)).toBe(true);
    expect(body.contentUrl).toBe(`/api/library/items/${s.itemId}/content`);
  });

  it("恢复历史版本：成功、参数错误、只读成员 403", async () => {
    const s = await sceneWithItem();
    authMock.userId = s.student.id;
    const url = `/api/library/items/${s.itemId}/restore`;
    const ok = await restoreRoute(
      new Request(`http://test${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      }),
      ctx(s.itemId),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).version).toBe(3);

    const bad = await restoreRoute(
      new Request(`http://test${url}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 0 }),
      }),
      ctx(s.itemId),
    );
    expect(bad.status).toBe(400);

    await addTextAttachment(s.owner.id, s.task.id, "团队只读.txt", "x");
    const teamRef = { kind: "team" as const, teamId: s.team.id };
    await syncOfTeam(s, teamRef);
    authMock.userId = s.teacher.id;
    const teamRoot = await listLibraryContents(s.teacher.id, teamRef);
    const folder = teamRoot.folders.find((f) => f.name === "任务附件")!.id;
    const view = await listLibraryContents(s.teacher.id, teamRef, folder);
    const itemId = view.items.find((i) => i.filename === "团队只读.txt")!.id;
    const forbidden = await restoreRoute(
      new Request(`http://test/api/library/items/${itemId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: 1 }),
      }),
      ctx(itemId),
    );
    expect(forbidden.status).toBe(403);
  });

  it("上传：folderId=root 落到资源库根目录", async () => {
    const s = await makeDocScene();
    authMock.userId = s.student.id;
    const res = await uploadRoute(
      new Request(
        "http://test/api/library/upload?scope=personal&folderId=root&name=root.txt&type=text/plain",
        {
          method: "POST",
          body: new TextEncoder().encode("根目录内容"),
        },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { itemId: string; folderId: string | null };
    expect(body.folderId).toBeNull();

    const ref = { kind: "personal" as const, userId: s.student.id };
    const root = await listLibraryContents(s.student.id, ref);
    expect(root.items.map((i) => i.filename)).toContain("root.txt");

    const content = await contentRoute(
      new Request(`http://test/api/library/items/${body.itemId}/content`),
      ctx(body.itemId),
    );
    expect(await content.text()).toBe("根目录内容");
  });
});

async function syncOfTeam(
  s: Awaited<ReturnType<typeof makeDocScene>>,
  ref: { kind: "team"; teamId: string },
) {
  const { syncTeamLibrary } = await import("@/lib/library/sync");
  await syncTeamLibrary(s.owner.id, ref.teamId, { force: true });
}
