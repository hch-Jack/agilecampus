import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMyTeams } from "@/lib/team";
import { TeamDirectory, type TeamDirectoryRow } from "./team-directory";
import { TeamForms } from "./team-forms";

export default async function TeamsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const myTeams = await listMyTeams(session.user.id);
  // 页面只把数据交给客户端筛选组件；Date 先转 ISO，跨 RSC 边界更稳妥
  const teams: TeamDirectoryRow[] = myTeams.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
  }));

  return (
    <main className="mx-auto max-w-5xl space-y-8 py-5 sm:py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">我的团队</h1>
      <TeamForms />
      <TeamDirectory teams={teams} />
    </main>
  );
}
