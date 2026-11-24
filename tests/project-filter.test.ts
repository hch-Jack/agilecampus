import { describe, expect, it } from "vitest";
import type { ProjectStatus } from "@/db/schema";
import { filterAndSortProjects } from "@/lib/project-filter";

function project(
  id: string,
  name: string,
  status: ProjectStatus,
  teamId: string,
  createdAt: string,
) {
  return { id, name, status, teamId, createdAt };
}

// 创建时间刻意乱序：默认排序必须真正按时间重排，而不是依赖入参顺序
const PROJECTS = [
  project("a", "敏捷校园平台", "active", "t1", "2026-01-10T00:00:00.000Z"),
  project("b", "AI 助手", "completed", "t2", "2026-01-05T00:00:00.000Z"),
  project("c", "旧版门户", "archived", "t1", "2026-01-20T00:00:00.000Z"),
];

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe("filterAndSortProjects", () => {
  it("默认按创建时间从新到旧", () => {
    expect(
      ids(filterAndSortProjects(PROJECTS, { query: "", status: "all", teamId: null, order: "newest" })),
    ).toEqual(["c", "a", "b"]);
  });

  it("可切换为最早创建在前", () => {
    expect(
      ids(filterAndSortProjects(PROJECTS, { query: "", status: "all", teamId: null, order: "oldest" })),
    ).toEqual(["b", "a", "c"]);
  });

  it("按名称子串搜索，忽略大小写与首尾空白", () => {
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "  ai  ",
          status: "all",
          teamId: null,
          order: "newest",
        }),
      ),
    ).toEqual(["b"]);
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "门户",
          status: "all",
          teamId: null,
          order: "newest",
        }),
      ),
    ).toEqual(["c"]);
  });

  it("按状态筛选", () => {
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "",
          status: "active",
          teamId: null,
          order: "newest",
        }),
      ),
    ).toEqual(["a"]);
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "",
          status: "archived",
          teamId: null,
          order: "newest",
        }),
      ),
    ).toEqual(["c"]);
  });

  it("按团队筛选（同团队多项目）", () => {
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "",
          status: "all",
          teamId: "t1",
          order: "newest",
        }),
      ),
    ).toEqual(["c", "a"]);
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "",
          status: "all",
          teamId: "t2",
          order: "newest",
        }),
      ),
    ).toEqual(["b"]);
  });

  it("名称、状态、团队、排序组合生效", () => {
    expect(
      ids(
        filterAndSortProjects(PROJECTS, {
          query: "版",
          status: "archived",
          teamId: "t1",
          order: "oldest",
        }),
      ),
    ).toEqual(["c"]);
  });

  it("没有命中时返回空数组", () => {
    expect(
      filterAndSortProjects(PROJECTS, {
        query: "不存在",
        status: "all",
        teamId: null,
        order: "newest",
      }),
    ).toEqual([]);
  });

  it("不修改入参数组", () => {
    const before = [...PROJECTS];
    filterAndSortProjects(PROJECTS, { query: "", status: "all", teamId: null, order: "newest" });
    expect(PROJECTS).toEqual(before);
  });
});
