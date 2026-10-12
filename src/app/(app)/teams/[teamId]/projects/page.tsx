import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getTeamMembership } from "@/lib/team";
import { listTeamProjects } from "@/lib/project";
import { ProjectForm } from "./project-form";
import { CardSparkles } from "@/components/card-sparkles";

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

  return (
    <main className="mx-auto max-w-2xl space-y-8 py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">项目</h1>
      <ul className="space-y-2">
        {projects.map((p) => (
          <li key={p.id}>
            <Link href={`/projects/${p.id}`} className="ac-card ac-card-link group block p-4">
              <span className="font-medium text-primary group-hover:underline">{p.name}</span>
              <span className="ml-2 text-xs text-ink-soft">{p.status}</span>
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
