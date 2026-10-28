import Link from "next/link";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { teams } from "@/db/schema";
import { getTeamMembership } from "@/lib/team";
import { listMembersWithPermissions } from "@/lib/team-permissions";
import { PermissionTable } from "./permission-table";

export default async function PermissionsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(teamId).success) notFound();

  // 团队成员可见（非管理员只读）；非成员 404，不泄露团队存在性
  const me = await getTeamMembership(session.user.id, teamId);
  if (!me) notFound();

  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) notFound();

  const members = await listMembersWithPermissions(teamId);

  return (
    <main className="mx-auto max-w-3xl space-y-6 py-8">
      <header className="space-y-1">
        <Link href="/teams" className="text-xs text-ink-soft hover:text-primary">
          ← 我的团队
        </Link>
        <h1 className="font-display text-2xl font-semibold text-ink">{team.name} · 权限管理</h1>
        <p className="text-sm text-ink-soft">
          三项审核权限按人勾选：勾选者可在工作台与消息页处理对应申请。
          管理员始终拥有全部权限，无须勾选。
        </p>
      </header>
      <PermissionTable
        teamId={teamId}
        members={members}
        isAdmin={me.role === "admin"}
        selfId={session.user.id}
      />
    </main>
  );
}
