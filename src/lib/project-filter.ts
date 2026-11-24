import type { ProjectStatus } from "@/db/schema";

export type ProjectStatusFilter = "all" | ProjectStatus;
export type ProjectSortOrder = "newest" | "oldest";

export type FilterableProject = {
  name: string;
  status: ProjectStatus;
  /** 所属团队：同名的两个团队靠 id 区分，不能拿 teamName 当筛选键 */
  teamId: string;
  /** 服务端传 ISO 字符串（Date 跨 RSC 边界前先序列化），测试里也接受 Date */
  createdAt: string | Date;
};

/**
 * 项目列表的筛选与排序（纯函数，客户端即时执行，无数据库往返）。
 *
 * - 名称：trim 后忽略大小写做子串匹配；
 * - 状态：all / active / completed / archived；
 * - 团队：null = 全部，否则按 teamId 精确匹配；
 * - 排序：按创建时间升/降序；时间相同保持入参顺序（Array#sort 稳定）。
 *
 * 返回新数组，不修改入参。
 */
export function filterAndSortProjects<T extends FilterableProject>(
  projects: readonly T[],
  opts: {
    query: string;
    status: ProjectStatusFilter;
    teamId: string | null;
    order: ProjectSortOrder;
  },
): T[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = projects.filter((project) => {
    if (q && !project.name.toLowerCase().includes(q)) return false;
    if (opts.status !== "all" && project.status !== opts.status) return false;
    if (opts.teamId && project.teamId !== opts.teamId) return false;
    return true;
  });

  const direction = opts.order === "newest" ? -1 : 1;
  return filtered.sort(
    (a, b) =>
      direction * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
  );
}
