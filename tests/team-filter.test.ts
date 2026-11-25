import { describe, expect, it } from "vitest";
import type { TeamRole } from "@/db/schema";
import { filterAndSortTeams } from "@/lib/team-filter";

function team(id: string, name: string, role: TeamRole, createdAt: string) {
  return { id, name, role, createdAt };
}

// 创建时间刻意乱序：默认排序必须真正按时间重排，而不是依赖入参顺序
const TEAMS = [
  team("a", "东吴实验室", "admin", "2026-01-10T00:00:00.000Z"),
  team("b", "曹魏参谋部", "student", "2026-01-05T00:00:00.000Z"),
  team("c", "AI Lab", "teacher", "2026-01-20T00:00:00.000Z"),
];

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("filterAndSortTeams", () => {
  it("默认按创建时间从新到旧", () => {
    expect(ids(filterAndSortTeams(TEAMS, { query: "", role: "all", order: "newest" }))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("可切换为最早创建在前", () => {
    expect(ids(filterAndSortTeams(TEAMS, { query: "", role: "all", order: "oldest" }))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("按名称子串搜索，忽略大小写与首尾空白", () => {
    expect(ids(filterAndSortTeams(TEAMS, { query: "  ai  ", role: "all", order: "newest" }))).toEqual(
      ["c"],
    );
    expect(ids(filterAndSortTeams(TEAMS, { query: "实验", role: "all", order: "newest" }))).toEqual([
      "a",
    ]);
  });

  it("管理员筛选只留 admin", () => {
    expect(ids(filterAndSortTeams(TEAMS, { query: "", role: "admin", order: "newest" }))).toEqual([
      "a",
    ]);
  });

  it("成员筛选包含导师与学生", () => {
    expect(ids(filterAndSortTeams(TEAMS, { query: "", role: "member", order: "newest" }))).toEqual([
      "c",
      "b",
    ]);
  });

  it("名称、身份、排序组合生效", () => {
    expect(
      ids(filterAndSortTeams(TEAMS, { query: "部", role: "member", order: "oldest" })),
    ).toEqual(["b"]);
  });

  it("没有命中时返回空数组", () => {
    expect(filterAndSortTeams(TEAMS, { query: "不存在", role: "all", order: "newest" })).toEqual([]);
  });

  it("不修改入参数组", () => {
    const before = [...TEAMS];
    filterAndSortTeams(TEAMS, { query: "", role: "all", order: "newest" });
    expect(TEAMS).toEqual(before);
  });
});
