import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getProjectForUser, listProjectMilestones } from "@/lib/project";
import { listTeamMembers } from "@/lib/team";
import { listProjectTasks } from "@/lib/task";
import { listProjectBoardComments } from "@/lib/comment";
import { splitBoardTasks } from "@/lib/board-tasks";
import { getFeedUnreadCount, listProjectActivities, projectFeedScope } from "@/lib/activity";
import { listTeamLabels } from "@/lib/label";
import {
  listPendingAcceptanceProjectIds,
  listPendingTaskDoneApprovals,
} from "@/lib/approval";
import { getMyPermissions } from "@/lib/team-permissions";
import { countProjectAttachments } from "@/lib/attachment";
import { AcceptanceControl } from "./acceptance-control";
import { parseFilters, applyFilters } from "@/lib/board-filters";
import { todayIn } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { ActivityFeed } from "@/components/activity-feed";
import { MilestoneSection } from "./milestone-section";
import { NewTaskForm } from "./new-task-form";
import { ProjectOverview } from "./project-overview";
import { TaskDatabase } from "./task-database";
import { Board } from "./board";
import { FilterBar } from "./filter-bar";
import { ProjectCommentList } from "./project-comment-list";

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

  const [
    projectMilestones,
    projectTasks,
    projectActivities,
    projectFeedUnread,
    members,
    teamLabels,
    projectBoardComments,
    attachmentCount,
  ] = await Promise.all([
    listProjectMilestones(session.user.id, projectId),
    listProjectTasks(session.user.id, projectId),
    listProjectActivities(session.user.id, projectId),
    getFeedUnreadCount(session.user.id, projectFeedScope(projectId)),
    listTeamMembers(project.teamId),
    listTeamLabels(session.user.id, project.teamId),
    listProjectBoardComments(session.user.id, projectId),
    countProjectAttachments(projectId),
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

  // 结题验收：有无待审申请（徽章 + 挡掉重复发起）、我是否有验收权（直接结题 vs 发起申请）；
  // 同时取任务完成申请：看板「待审批」列据此派生（不新增任务状态）
  const [acceptancePending, myPerms, pendingTaskApprovals] = await Promise.all([
    listPendingAcceptanceProjectIds([projectId]),
    getMyPermissions(session.user.id, project.teamId),
    listPendingTaskDoneApprovals(projectTasks.map((t) => t.id)),
  ]);
  const pendingAcceptance = acceptancePending.has(projectId);
  const canAccept = myPerms?.project ?? false;
  const canApproveTaskDone = myPerms?.taskDone ?? false;
  // 概览进度：项目内全部任务（含子任务）的完成数
  const taskDone = projectTasks.filter((t) => t.status === "done").length;

  return (
    <main className="page-wide space-y-8 py-5 sm:py-8">
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
      </header>

      {/* 项目概览：Notion 属性面板式信息卡，集中呈现状态/周期/进度/成员/里程碑/描述 */}
      <ProjectOverview
        project={{
          description: project.description,
          status: project.status,
          startDate: project.startDate,
          endDate: project.endDate,
        }}
        taskTotal={projectTasks.length}
        taskDone={taskDone}
        members={members.map((m) => ({ id: m.id, name: m.name }))}
        milestoneCount={projectMilestones.length}
        pendingAcceptance={pendingAcceptance}
      />

      {/* 结题入口：有验收权=直接结题；无权=发起申请（全部任务完成后可提交） */}
      <AcceptanceControl
        projectId={projectId}
        projectName={project.name}
        status={project.status}
        pendingAcceptance={pendingAcceptance}
        canAccept={canAccept}
      />
      {project.status !== "active" && (
        <p className="text-xs text-ink-faint">
          项目已{project.status === "completed" ? "结题" : "归档"}，工作台不再统计其任务。
        </p>
      )}

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
            const pending = pendingTaskApprovals.get(t.id);
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
              requireApproval: t.requireApproval,
              subTotal: p?.total,
              subDone: p?.done,
              pendingApproval: pending
                ? {
                    requestId: pending.requestId,
                    // 申请人自己看不到通过/拒绝按钮（decideApproval 同样拒绝自批）
                    canDecide:
                      canApproveTaskDone && pending.requesterId !== session.user.id,
                  }
                : undefined,
            };
          })}
          canWrite={canWrite}
          viewerRole={role}
          members={members}
          milestones={projectMilestones.map((m) => ({ id: m.id, name: m.title }))}
        />
      </section>

      {/* 任务数据库：Notion 数据库式的任务总览（只读，操作在看板/详情页） */}
      <TaskDatabase
        projectId={projectId}
        tasks={projectTasks}
        milestones={projectMilestones.map((m) => ({ id: m.id, title: m.title }))}
        progress={progress}
      />

      {/* 新建任务与附件中心并排一行：任务卡收窄，附件中心做固定宽度的入口卡 */}
      <div
        className={`grid items-stretch gap-4 ${
          canWrite ? "lg:grid-cols-[minmax(0,1fr)_15rem]" : ""
        }`}
      >
        {canWrite && (
          <NewTaskForm
            projectId={projectId}
            members={members}
            milestones={projectMilestones.map((m) => ({ id: m.id, title: m.title }))}
            projectStart={project.startDate}
            projectEnd={project.endDate}
          />
        )}
        <Link
          href={`/projects/${projectId}/attachments`}
          className="ac-card flex flex-col justify-center gap-1.5 p-4 transition-colors hover:border-primary/60 hover:bg-primary-soft/30"
        >
          <span className="flex items-center gap-2 font-medium text-ink">
            <svg
              viewBox="0 0 16 16"
              className="h-4 w-4 shrink-0 text-ink-soft"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M13 7.5 8.6 12a3.2 3.2 0 0 1-4.6-4.6l4.6-4.6a2.1 2.1 0 0 1 3 3L7 10.2a1.05 1.05 0 0 1-1.5-1.5l4.1-4.1" />
            </svg>
            附件中心
          </span>
          <span className="text-xs text-ink-faint">
            {attachmentCount > 0
              ? `已归档 ${attachmentCount} 个文件`
              : "按任务上传与查看项目文件"}
          </span>
        </Link>
      </div>

      {/* 项目留言板：对标任务留言板，挂在新任务与最新记录之间 */}
      <section className="ac-card p-5">
        <ProjectCommentList
          projectId={projectId}
          comments={projectBoardComments}
          currentUserId={session.user.id}
          canComment={true}
          timeZone={tz}
          members={members}
        />
      </section>

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
