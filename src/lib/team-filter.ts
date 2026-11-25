import type { TeamRole } from "@/db/schema";

export type TeamRoleFilter = "all" | "admin" | "member";
export type TeamSortOrder = "newest" | "oldest";

export type FilterableTeam = {
  name: string;
  role: TeamRole;
  /** 服务端传 ISO 字符串（Date 跨 RSC 边界前先序列化），测试里也接受 Date */
  createdAt: string | Date;
};

/**
 * 团队列表的筛选与排序（纯函数，客户端即时执行，无数据库往返）。
 *
 * - 名称：trim 后忽略大小写做子串匹配；
 * - 身份：admin = 管理员，member = 其余角色（导师 / 学生）；
 * - 排序：按创建时间升/降序；时间相同保持入参顺序（Array#sort 稳定）。
 *
 * 返回新数组，不修改入参。
 */
export function filterAndSortTeams<T extends FilterableTeam>(
  teams: readonly T[],
  opts: { query: string; role: TeamRoleFilter; order: TeamSortOrder },
): T[] {
  const q = opts.query.trim().toLowerCase();
  const filtered = teams.filter((team) => {
    if (q && !team.name.toLowerCase().includes(q)) return false;
    if (opts.role === "admin" && team.role !== "admin") return false;
    if (opts.role === "member" && team.role === "admin") return false;
    return true;
  });

  const direction = opts.order === "newest" ? -1 : 1;
  return filtered.sort(
    (a, b) =>
      direction * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
  );
}
