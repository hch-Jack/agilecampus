import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getTeamMembership } from "@/lib/team";
import { listTeamProjects } from "@/lib/project";
import { listPendingAcceptanceProjectIds } from "@/lib/approval";
import { ProjectForm } from "./project-form";
import { CardSparkles } from "@/components/card-sparkles";

// 项目状态 → 徽章（结题=验收通过，与审批流的 project_acceptance 对应）
const STATUS_BADGE = {
  active: "bg-doing/10 text-doing",
  completed: "bg-done/10 text-done",
  archived: "bg-sunken text-ink-soft",
} as const;
const STATUS_LABEL = { active: "进行中", completed: "已结题", archived: "已归档" } as const;

export default async function ProjectsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(teamId).success) notFound();

  const me = await getTeamMembership(session.user.id, teamId);
  if (!me) notFound();

  const projects = await listTeamProjects(session.user.id, teamId);
  const isAdmin = me.role === "admin";
  // 有待审结题申请的项目（列表上的「结题审批中」角标）
  const pendingAcceptance = await listPendingAcceptanceProjectIds(projects.map((p) => p.id));

  return (
    <main className="mx-auto max-w-2xl space-y-8 py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">项目</h1>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id}>
            {/* relative 是给 CardSparkles 的定位祖先，别删（见 card-sparkles.tsx 的说明） */}
            <Link href={`/projects/${p.id}`} className="ac-card ac-card-link group relative block p-4">
              <span className="font-medium text-primary group-hover:underline">{p.name}</span>
              <span className={`ac-badge ml-2 ${STATUS_BADGE[p.status]}`}>{STATUS_LABEL[p.status]}</span>
              {pendingAcceptance.has(p.id) && (
                <span className="ac-badge ml-1.5 border border-medium bg-medium-soft font-medium text-medium">
                  ⏳ 结题审批中
                </span>
              )}
              {(p.startDate || p.endDate) && (
                <span className="ml-2 text-xs text-ink-faint">
                  {p.startDate ?? "?"} ~ {p.endDate ?? "?"}
                </span>
              )}
              {p.description && (
                <p className="mt-1 text-sm text-ink-soft">{p.description}</p>
              )}
              <CardSparkles />
            </Link>
          </li>
        ))}
        {projects.length === 0 && (
          <li className="text-sm text-ink-soft">
            暂无项目{isAdmin ? "，在下方创建第一个。" : "。"}
          </li>
        )}
      </ul>
      {isAdmin && <ProjectForm teamId={teamId} />}
    </main>
  );
}
