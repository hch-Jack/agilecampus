import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMyTeams } from "@/lib/team";
import { RoleBadge } from "@/components/badges";
import { DissolveTeamForm } from "./dissolve-team-form";
import { ExitTeamForm } from "./exit-team-form";
import { TeamForms } from "./team-forms";
import { TeamsFilter } from "./teams-filter";

export default async function TeamsPage({
  searchParams,
}: {
  searchParams: Promise<{ created?: string; admin?: string; member?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const myTeams = await listMyTeams(session.user.id);
  const filters = await searchParams;
  // 我创建的（建团记录在案）；管理员/普通成员（当前角色）
  const filtered = myTeams.filter(
    (t) =>
      (!filters.created || t.createdById === session.user.id) &&
      (!filters.admin || t.role === "admin") &&
      (!filters.member || t.role !== "admin"),
  );
  const filteredView = Boolean(filters.created || filters.admin || filters.member);

  return (
    <main className="mx-auto max-w-2xl space-y-8 py-5 sm:py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">我的团队</h1>
      {myTeams.length > 0 && (
        <TeamsFilter total={myTeams.length} visible={filtered.length} />
      )}
      {filtered.length === 0 ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          {filteredView
            ? "没有符合筛选条件的团队。"
            : "尚未加入任何团队——在下方创建一个，或凭邀请码加入。"}
        </div>
      ) : (
        <ul className="space-y-3">
          {filtered.map((t) => (
            <li key={t.id} className="ac-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-display text-base font-semibold text-ink">
                      {t.name}
                    </span>
                    <RoleBadge role={t.role} />
                  </div>
                  <p className="mt-1 text-xs text-ink-faint">
                    邀请码 <span className="font-mono text-ink-soft">{t.inviteCode}</span>
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                <Link href={`/teams/${t.id}/projects`} className="ac-btn-ghost">
                  项目
                </Link>
                <Link href={`/teams/${t.id}/resources`} className="ac-btn-ghost">
                  资源占用
                </Link>
                <Link href={`/teams/${t.id}/members`} className="ac-btn-ghost">
                  成员管理
                </Link>
                <Link href={`/teams/${t.id}/labels`} className="ac-btn-ghost">
                  标签
                </Link>
                <Link href={`/teams/${t.id}/permissions`} className="ac-btn-ghost">
                  权限管理
                </Link>
              </div>
              {/* 解散/退出按钮统一放在卡片右下角，成员页内不再出现 */}
              {t.role === "admin" ? (
                <DissolveTeamForm teamId={t.id} teamName={t.name} counts={t.counts} />
              ) : (
                <ExitTeamForm teamId={t.id} teamName={t.name} />
              )}
            </li>
          ))}
        </ul>
      )}
      <TeamForms />
    </main>
  );
}
