import { z } from "zod";
import { eq } from "drizzle-orm";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { teamMembers, teams, users } from "@/db/schema";
import { getTeamMembership, teamContentCounts } from "@/lib/team";
import { LeaveTeamForm, MemberRow } from "./member-forms";

export default async function MembersPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  // teamId 来自 URL，非法 uuid 会导致后续查询报 DB 错误——提前拦截，语义上等同于「不存在」
  if (!z.uuid().safeParse(teamId).success) notFound();

  // 访问者必须是团队成员（非成员 404，不泄露团队存在性）
  const me = await getTeamMembership(session.user.id, teamId);
  if (!me) notFound();

  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team) notFound();

  const members = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      role: teamMembers.role,
      // 注册身份。加入团队时的角色本就是按它定的（lib/team.ts 的 initialTeamRole），
      // 名单上把它显示出来，用户才看得见这条规则
      identity: users.identity,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId));

  const isAdmin = me.role === "admin";
  const adminCount = members.filter((m) => m.role === "admin").length;
  // 只剩自己 → 退出即解散（与 lib 层 leaveTeam 的判定口径一致）
  const willDissolve = members.length === 1;
  // 唯一管理员且团里还有别人 → 必须先指定接任者
  const needsSuccessor = isAdmin && adminCount === 1 && !willDissolve;
  const candidates = members
    .filter((m) => m.userId !== session.user.id)
    .map((m) => ({ userId: m.userId, name: m.name }));

  // 「退出即解散」的确认框要说清会删掉什么；只有这一种形态需要，才查
  const counts = willDissolve ? await teamContentCounts(teamId) : undefined;

  return (
    <main className="mx-auto max-w-2xl space-y-6 py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">{team.name} · 成员</h1>
      <ul className="space-y-2">
        {members.map((m) => (
          <MemberRow
            key={m.userId}
            teamId={teamId}
            member={m}
            isAdmin={isAdmin}
            isSelf={m.userId === session.user.id}
          />
        ))}
      </ul>
      <LeaveTeamForm
        teamId={teamId}
        teamName={team.name}
        willDissolve={willDissolve}
        needsSuccessor={needsSuccessor}
        candidates={candidates}
        counts={counts}
      />
    </main>
  );
}
