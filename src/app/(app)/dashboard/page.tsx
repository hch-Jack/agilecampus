import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMySubtaskProgress, listMyTasks } from "@/lib/task";
import { getFeedUnreadCount, listMyTaskActivities, WORKBENCH_SCOPE } from "@/lib/activity";
import { addDays, todayIn, weekdayOfDate } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { pickProjectFilter, projectChips } from "@/lib/workbench-filters";
import { buildWorkbenchStats } from "@/lib/workbench-stats";
import { getDashboardLayout } from "@/lib/dashboard-layout-store";
import { listMyProjects } from "@/lib/project";
import { listMyTeams } from "@/lib/team";
import { countUnread } from "@/lib/dm";
import { countGroupUnread, countPendingGroupInvites } from "@/lib/group-chat";
import { DashboardGrid } from "./dashboard-grid";
import type { DashboardData } from "./dashboard-types";
import type { WorkbenchTask } from "./workbench-board";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const hideDone = typeof sp.hideDone === "string" && sp.hideDone === "1";

  const session = await auth();
  if (!session?.user) redirect("/login");
  const userId = session.user.id;

  // 所有卡片的数据无条件加载：加卡时不必再请求服务端，也就没有数据空窗。
  // 代价是每次打开工作台多几条小查询；若将来要优化，再按布局裁剪。
  const [
    myTasks,
    feed,
    feedUnread,
    layout,
    projects,
    teams,
    dmUnread,
    groupUnread,
    pendingInvites,
    tz,
  ] = await Promise.all([
    listMyTasks(userId),
    listMyTaskActivities(userId), // 全量口径，不受任何筛选影响
    getFeedUnreadCount(userId, WORKBENCH_SCOPE),
    getDashboardLayout(userId),
    listMyProjects(userId),
    listMyTeams(userId),
    countUnread(userId),
    countGroupUnread(userId),
    countPendingGroupInvites(userId),
    resolveUserTimeZone(userId),
  ]);

  // 「今天 / 本周截止」一律按**用户自己的时区**在服务端算成 YYYY-MM-DD，
  // 再由服务端传给看板 —— 客户端不取时钟，免得同一个人在两处看到不同的「今天」。
  // 周日的算法也走日历字符串（addDays），不要用 setDate：那会把宿主时区绕回来。
  const now = new Date();
  const today = todayIn(tz, now);
  const weekEnd = addDays(today, (7 - weekdayOfDate(today)) % 7);

  // 子任务进度合并进卡片数据（只认直接子级聚合的父 id）
  const byParent = new Map(
    (await listMySubtaskProgress(myTasks.map((t) => t.id))).flatMap((r) =>
      r.parentTaskId ? [[r.parentTaskId, r] as const] : [],
    ),
  );
  const enriched: WorkbenchTask[] = myTasks.map((t) => {
    const p = byParent.get(t.id);
    return p ? { ...t, subTotal: p.total, subDone: p.done } : t;
  });

  // 筛选管线：统计/动态流用全量；看板先过项目再过 hideDone
  const projectFilter = pickProjectFilter(sp.project, myTasks);
  const chips = projectChips(myTasks);
  const projectScoped = projectFilter
    ? enriched.filter((t) => t.projectId === projectFilter)
    : enriched;
  const doneCount = projectScoped.filter((t) => t.status === "done").length;
  const visibleTasks = hideDone
    ? projectScoped.filter((t) => t.status !== "done")
    : projectScoped;

  // 「即将到期」：未完成且带截止日的最近几条（listMyTasks 已按 dueDate 升序、NULL 最后）
  const upcoming = enriched
    .filter((t) => t.status !== "done" && t.dueDate !== null)
    .slice(0, 8)
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: t.projectName,
      dueDate: t.dueDate as string,
    }));

  const data: DashboardData = {
    visibleTasks,
    doneCount,
    hideDone,
    projectFilter,
    chips,
    stats: buildWorkbenchStats(enriched, today, weekEnd),
    today,
    feed,
    feedUnread,
    feedScope: WORKBENCH_SCOPE,
    tz,
    now,
    // 团队邀请码等无关字段不进 RSC 载荷；列表长度也在这里收口
    projects: projects.slice(0, 8).map((p) => ({
      id: p.id,
      name: p.name,
      teamName: p.teamName,
      status: p.status,
      taskTotal: p.taskTotal,
      doneCount: p.doneCount,
    })),
    teams: teams.slice(0, 8).map((t) => ({
      id: t.id,
      name: t.name,
      role: t.role,
      counts: t.counts,
    })),
    upcoming,
    messages: { dm: dmUnread, group: groupUnread, invites: pendingInvites },
  };

  return (
    <main className="mx-auto max-w-5xl py-8">
      <DashboardGrid initialLayout={layout} data={data} />
    </main>
  );
}
