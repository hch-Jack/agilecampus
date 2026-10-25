import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getProjectForUser, listProjectMilestones } from "@/lib/project";
import { listTeamMembers } from "@/lib/team";
import { listProjectTasks } from "@/lib/task";
import { splitBoardTasks } from "@/lib/board-tasks";
import { getFeedUnreadCount, listProjectActivities, projectFeedScope } from "@/lib/activity";
import { listTeamLabels } from "@/lib/label";
import { parseFilters, applyFilters } from "@/lib/board-filters";
import { todayIn } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { ActivityFeed } from "@/components/activity-feed";
import { MilestoneSection } from "./milestone-section";
import { NewTaskForm } from "./new-task-form";
import { Board } from "./board";
import { FilterBar } from "./filter-bar";

export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const access = await getProjectForUser(session.user.id, projectId);
  if (!access) notFound();
  const { project, role } = access;

  const [projectMilestones, projectTasks, projectActivities, projectFeedUnread, members, teamLabels] =
    await Promise.all([
      listProjectMilestones(session.user.id, projectId),
      listProjectTasks(session.user.id, projectId),
      listProjectActivities(session.user.id, projectId),
      getFeedUnreadCount(session.user.id, projectFeedScope(projectId)),
      listTeamMembers(project.teamId),
      listTeamLabels(session.user.id, project.teamId),
    ]);

  const filters = parseFilters(
    new URLSearchParams(
      Object.entries(sp).flatMap(([k, v]) =>
        typeof v === "string" ? [[k, v] as [string, string]] : [],
      ),
    ),
  );
  // 「今日」按**用户自己的时区**取 YYYY-MM-DD，随后仅作字符串比较。
  // 别用 toLocaleDateString("sv-SE")：那是宿主进程的今天，容器里就是 UTC。
  const tz = await resolveUserTimeZone(session.user.id);
  const now = new Date();
  const today = todayIn(tz, now);
  const visibleTasks = applyFilters(projectTasks, filters, today);
  // 看板只摆顶层任务：子任务不单独成卡，改为父卡底部的进度条。
  // 进度按项目全量子任务聚合，不受筛选影响（筛选的是父任务卡片）。
  const { topLevel, progress } = splitBoardTasks(projectTasks);
  const visibleTopLevel = visibleTasks.filter((t) => !t.parentTaskId);

  const canWrite = role === "admin" || role === "student";
  const isAdmin = role === "admin";

  return (
    <main className="mx-auto max-w-5xl space-y-8 py-8">
      <header>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="min-w-0 font-display text-2xl font-semibold text-ink">
            {project.name}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href={`/projects/${projectId}/timeline`}
              className="ac-btn-ghost whitespace-nowrap"
            >
              时间线
            </Link>
            <Link
              href={`/projects/${projectId}/graph`}
              className="ac-btn-ghost whitespace-nowrap"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                aria-hidden="true"
              >
                <circle cx="4" cy="4" r="2" />
                <circle cx="12" cy="8" r="2" />
                <circle cx="4" cy="12" r="2" />
                <path d="M5.7 4.8 10.3 7.2M10.3 8.8 5.7 11.2" />
              </svg>
              关系图
            </Link>
            <Link
              href={`/projects/${projectId}/flow`}
              className="ac-btn-ghost whitespace-nowrap"
            >
              <svg
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                aria-hidden="true"
              >
                <rect x="1.5" y="2.5" width="4.5" height="3.5" rx="1" />
                <rect x="10" y="6.2" width="4.5" height="3.5" rx="1" />
                <rect x="1.5" y="10" width="4.5" height="3.5" rx="1" />
                <path d="M6 4.2h2.2v3.8H10M6 11.8h2.2V7.9H10" />
              </svg>
              流程图
            </Link>
          </div>
        </div>
        {project.description && (
          <p className="mt-1 text-sm text-ink-soft">{project.description}</p>
        )}
        <p className="mt-1 text-xs text-ink-faint">
          {project.startDate ?? "?"} ~ {project.endDate ?? "?"} · {project.status}
        </p>
      </header>

      <MilestoneSection
        projectId={projectId}
        milestones={projectMilestones}
        isAdmin={isAdmin}
      />

      <section className="space-y-3">
        <h2 className="font-medium text-ink">看板</h2>
        <FilterBar
          members={members.map((m) => ({ id: m.id, name: m.name }))}
          milestones={projectMilestones.map((m) => ({ id: m.id, name: m.title }))}
          labels={teamLabels.map((l) => ({ id: l.id, name: l.name }))}
          visible={visibleTopLevel.length}
          total={topLevel.length}
        />
        <Board
          projectId={projectId}
          groupBy={filters.group}
          tasks={visibleTopLevel.map((t) => {
            const p = progress.get(t.id);
            return {
              id: t.id,
              title: t.title,
              description: t.description,
              completionNote: t.completionNote,
              status: t.status,
              priority: t.priority,
              startDate: t.startDate,
              dueDate: t.dueDate,
              assigneeName: t.assigneeName,
              assigneeId: t.assigneeId,
              milestoneId: t.milestoneId,
              labels: t.labels,
              subTotal: p?.total,
              subDone: p?.done,
            };
          })}
          canWrite={canWrite}
          viewerRole={role}
          members={members}
          milestones={projectMilestones.map((m) => ({ id: m.id, name: m.title }))}
        />
      </section>

      {canWrite && (
        <NewTaskForm
          projectId={projectId}
          members={members}
          milestones={projectMilestones.map((m) => ({ id: m.id, title: m.title }))}
          projectStart={project.startDate}
          projectEnd={project.endDate}
        />
      )}

      {/* 本项目专属口径：只统计该项目的记录（不限「分配给我」）；「清除记录」只清自己视角 */}
      <ActivityFeed
        activities={projectActivities}
        tz={tz}
        now={now}
        unreadScope={projectFeedScope(projectId)}
        unreadCount={projectFeedUnread}
        clearScope={projectFeedScope(projectId)}
      />
    </main>
  );
}
