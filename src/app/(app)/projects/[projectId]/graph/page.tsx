import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectForUser, listProjectMilestones } from "@/lib/project";
import { listProjectDependencies, listProjectTasks } from "@/lib/task";
import { parseDay } from "@/lib/gantt";
import { todayIn } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { RelationshipGraph } from "./relationship-graph";

export default async function RelationshipGraphPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const access = await getProjectForUser(session.user.id, projectId);
  if (!access) notFound();

  const [tasks, milestones, dependencies] = await Promise.all([
    listProjectTasks(session.user.id, projectId),
    listProjectMilestones(session.user.id, projectId),
    listProjectDependencies(session.user.id, projectId),
  ]);

  const tz = await resolveUserTimeZone(session.user.id);
  const todayMs = parseDay(todayIn(tz))!;

  return (
    <main className="mx-auto max-w-5xl space-y-6 py-8">
      <header className="space-y-1">
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <Link href={`/projects/${projectId}`} className="hover:text-primary">
            ← 返回项目
          </Link>
          <Link href={`/projects/${projectId}/timeline`} className="hover:text-primary">
            时间线 →
          </Link>
          <Link href={`/projects/${projectId}/flow`} className="hover:text-primary">
            流程图 →
          </Link>
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink">
          {access.project.name} · 关系图
        </h1>
        <p className="text-sm text-ink-soft">
          按父子层级排列任务，横条为起止日期，箭头为任务依赖。点击任务查看详情。
        </p>
      </header>

      <RelationshipGraph
        projectId={projectId}
        todayMs={todayMs}
        projectStartDate={access.project.startDate}
        projectEndDate={access.project.endDate}
        tasks={tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          startDate: t.startDate,
          dueDate: t.dueDate,
          parentTaskId: t.parentTaskId,
          sortOrder: t.sortOrder,
        }))}
        milestones={milestones.map((m) => ({
          id: m.id,
          title: m.title,
          targetDate: m.targetDate,
        }))}
        dependencies={dependencies}
      />
    </main>
  );
}
