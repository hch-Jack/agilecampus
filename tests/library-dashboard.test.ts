import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { getDashboardLibrarySummary } from "@/lib/library/summary";
import { listMyTeamNames } from "@/lib/team";
import { syncPersonalLibrary, syncTeamLibrary } from "@/lib/library/sync";
import { resetDb } from "./helpers";
import { addTextAttachment, makeDocScene, setupTempUploadDir, teardownTempUploadDir } from "./documents-helpers";

beforeAll(setupTempUploadDir);
afterAll(teardownTempUploadDir);
beforeEach(resetDb);

describe("工作台资源库卡片数据", () => {
  it("汇总个人库与团队库的文件数、最近更新", async () => {
    const s = await makeDocScene();
    await addTextAttachment(s.student.id, s.task.id, "个人文件.txt", "a");
    await addTextAttachment(s.owner.id, s.task.id, "团队文件.txt", "bbbb");
    await syncPersonalLibrary(s.student.id, { force: true });
    await syncTeamLibrary(s.owner.id, s.team.id, { force: true });

    const summary = await getDashboardLibrarySummary(s.student.id, [
      { id: s.team.id, name: s.team.name },
    ]);
    expect(summary.personalCount).toBe(1);
    expect(summary.teams.find((t) => t.id === s.team.id)?.itemCount).toBe(2);
    expect(summary.totalCount).toBe(3);
    expect(summary.recent.length).toBeGreaterThan(0);
    expect(
      summary.recent.some((f) => f.filename === "团队文件.txt" && f.teamName === s.team.name),
    ).toBe(true);

    // 顶栏下拉用的轻量列表
    expect(await listMyTeamNames(s.student.id)).toEqual([
      { id: s.team.id, name: s.team.name },
    ]);
  });

  it("没有资源库时返回全 0，不报错", async () => {
    const s = await makeDocScene();
    const summary = await getDashboardLibrarySummary(s.student.id, [
      { id: s.team.id, name: s.team.name },
    ]);
    expect(summary.personalCount).toBe(0);
    expect(summary.totalCount).toBe(0);
    expect(summary.recent).toEqual([]);
  });
});
