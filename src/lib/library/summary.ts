import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { libraries, libraryItems } from "@/db/schema";
import type { DashboardLibraryFile, DashboardLibrarySummary } from "@/app/(app)/dashboard/dashboard-types";

/**
 * 工作台「资源库」卡片数据：个人库 / 各团队库的文件数与最近更新。
 * 不触发同步（工作台每次加载都跑全量同步太重），显示上次同步后的状态；点进资源库会刷新。
 */
export async function getDashboardLibrarySummary(
  userId: string,
  teams: { id: string; name: string }[],
): Promise<DashboardLibrarySummary> {
  const teamIds = teams.map((team) => team.id);
  const rows = await db
    .select()
    .from(libraries)
    .where(
      teamIds.length > 0
        ? or(
            and(eq(libraries.kind, "personal"), eq(libraries.ownerId, userId)),
            and(eq(libraries.kind, "team"), inArray(libraries.teamId, teamIds)),
          )
        : and(eq(libraries.kind, "personal"), eq(libraries.ownerId, userId)),
    );

  const personalLibrary = rows.find((row) => row.kind === "personal") ?? null;
  const teamLibraryByTeam = new Map(
    rows
      .filter((row) => row.kind === "team" && row.teamId)
      .map((row) => [row.teamId!, row]),
  );
  const libraryIds = rows.map((row) => row.id);

  const counts =
    libraryIds.length === 0
      ? []
      : await db
          .select({
            libraryId: libraryItems.libraryId,
            count: sql<number>`count(*)::int`,
          })
          .from(libraryItems)
          .where(inArray(libraryItems.libraryId, libraryIds))
          .groupBy(libraryItems.libraryId);
  const countByLibrary = new Map(
    counts.map((row) => [row.libraryId, Number(row.count)]),
  );

  const recentRows =
    libraryIds.length === 0
      ? []
      : await db
          .select({
            id: libraryItems.id,
            libraryId: libraryItems.libraryId,
            filename: libraryItems.filename,
            size: libraryItems.size,
            updatedAt: libraryItems.updatedAt,
          })
          .from(libraryItems)
          .where(inArray(libraryItems.libraryId, libraryIds))
          .orderBy(desc(libraryItems.updatedAt))
          .limit(8);

  const teamNameById = new Map(teams.map((team) => [team.id, team.name]));
  const scopeOf = (libraryId: string): { scope: "personal" | "team"; teamId?: string; teamName: string } => {
    if (personalLibrary?.id === libraryId) return { scope: "personal", teamName: "个人资源库" };
    const teamLib = rows.find((row) => row.id === libraryId && row.kind === "team");
    const teamId = teamLib?.teamId ?? undefined;
    return {
      scope: "team",
      teamId,
      teamName: teamId ? (teamNameById.get(teamId) ?? "团队资源库") : "团队资源库",
    };
  };

  const recent: DashboardLibraryFile[] = recentRows.map((row) => ({
    id: row.id,
    filename: row.filename,
    size: row.size,
    updatedAt: row.updatedAt,
    ...scopeOf(row.libraryId),
  }));

  const teamSummaries = teams
    .map((team) => {
      const lib = teamLibraryByTeam.get(team.id);
      return {
        id: team.id,
        name: team.name,
        itemCount: lib ? (countByLibrary.get(lib.id) ?? 0) : 0,
      };
    })
    .sort((a, b) => b.itemCount - a.itemCount);

  return {
    personalCount: personalLibrary
      ? (countByLibrary.get(personalLibrary.id) ?? 0)
      : 0,
    teams: teamSummaries,
    totalCount: libraryIds.reduce((sum, id) => sum + (countByLibrary.get(id) ?? 0), 0),
    recent,
  };
}
