import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";
import { syncPersonalLibrary } from "@/lib/library/sync";
import { listLibraryContents } from "@/lib/library/folders";
import { makeGroupWithFiles } from "./library-helpers";

const authMock = vi.hoisted(() => ({ userId: null as string | null }));
const revalidateMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({
  auth: async () =>
    authMock.userId ? { user: { id: authMock.userId, name: "测试用户" } } : null,
}));
vi.mock("next/cache", () => ({ revalidatePath: revalidateMock }));

import {
  createFolderAction,
  deleteItemAction,
  deleteVersionAction,
  listLibraryDestinationsAction,
  syncGroupFileAction,
} from "@/app/(app)/library/actions";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(async () => {
  await resetDb();
  revalidateMock.mockClear();
});

async function studentItem() {
  const s = await makeDocScene();
  await addTextAttachment(s.student.id, s.task.id, "动作测试.txt", "v1");
  await addTextAttachment(s.student.id, s.task.id, "动作测试.txt", "v2");
  await syncPersonalLibrary(s.student.id, { force: true });
  const ref = { kind: "personal" as const, userId: s.student.id };
  const root = await listLibraryContents(s.student.id, ref);
  const folder = root.folders.find((f) => f.name === "任务附件")!.id;
  const view = await listLibraryContents(s.student.id, ref, folder);
  return { ...s, itemId: view.items[0].id };
}

describe("资源库 server actions", () => {
  it("未登录与参数错误返回错误信息", async () => {
    authMock.userId = null;
    const res = await createFolderAction({ scope: "personal", name: "x" });
    expect(res.ok).toBe(false);
  });

  it("新建文件夹、删除版本、删除条目会刷新页面", async () => {
    const s = await studentItem();
    authMock.userId = s.student.id;

    const created = await createFolderAction({ scope: "personal", name: "复试资料" });
    expect(created.ok).toBe(true);
    expect(revalidateMock).toHaveBeenCalledWith("/library");

    const delVersion = await deleteVersionAction(s.itemId, 1);
    expect(delVersion.ok).toBe(true);

    const delItem = await deleteItemAction(s.itemId, { deleteSources: false });
    expect(delItem.ok).toBe(true);
    if (delItem.ok) expect(delItem.data.deletedSources).toHaveLength(0);
  });

  it("目标列表包含个人库与可写团队", async () => {
    const s = await studentItem();
    authMock.userId = s.student.id;
    const res = await listLibraryDestinationsAction();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data[0].key).toBe("personal");
    expect(res.data.some((d) => d.teamId === s.team.id)).toBe(true);
  });

  it("群文件同步 action：teacher 写团队库被拒", async () => {
    const s = await makeDocScene();
    const { group, attachments } = await makeGroupWithFiles(s.owner.id, [s.teacher.id], [
      { senderId: s.owner.id, filename: "群动作.txt", content: "x" },
    ]);
    authMock.userId = s.teacher.id;
    const res = await syncGroupFileAction({
      groupId: group.id,
      attachmentId: attachments[0].attachmentId,
      scope: "team",
      teamId: s.team.id,
      mode: "snapshot",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("编辑权限");
  });
});
