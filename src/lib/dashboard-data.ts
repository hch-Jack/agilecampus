// 工作台 / 常驻栏共用的卡片数据装配。
//
// 工作台要全套数据（加卡时不必再回服务端）；常驻栏在**每个页面**都要数据，
// 必须能按布局裁剪，所以这里支持 `only`：只查当前布局里真有卡片的那些数据。
// 查询本身用 React `cache()` 包了一层 —— 同一次请求里 `(app)/layout.tsx` 与
// 页面即使各自调用，相同参数也只会打到数据库一次。

import { cache } from "react";
import { listMySubtaskProgress, listMyTasks } from "@/lib/task";
import { getFeedUnreadCount, listMyTaskActivities, WORKBENCH_SCOPE } from "@/lib/activity";
import { addDays, todayIn, weekdayOfDate } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { listMyTaskPlans } from "@/lib/task-plan";
import { pickProjectFilter, projectChips } from "@/lib/workbench-filters";
import { buildWorkbenchStats } from "@/lib/workbench-stats";
import { listMyProjects, listMyUpcomingMilestones } from "@/lib/project";
import { listMyTeams } from "@/lib/team";
import { listMyTeamResourceUsages } from "@/lib/resource";
import {
  countUnreadSystemMessages,
  isApproverAnywhere,
  listMyTaskApprovalSummaries,
  listPendingApprovalsForApprover,
} from "@/lib/approval";
import { listMyRecentAttachments } from "@/lib/attachment";
import { countUnread } from "@/lib/dm";
import { countGroupUnread, countPendingGroupInvites } from "@/lib/group-chat";
import {
  STAT_WIDGET_IDS,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";
import type { DashboardData } from "@/app/(app)/dashboard/dashboard-types";
import type { WorkbenchTask } from "@/app/(app)/dashboard/workbench-board";

// 参数相同的查询在同一请求内只执行一次（layout 与页面共享）。
const cachedListMyTasks = cache(listMyTasks);
const cachedListMyTaskActivities = cache(listMyTaskActivities);
const cachedGetFeedUnreadCount = cache(getFeedUnreadCount);
const cachedListMyProjects = cache(listMyProjects);
const cachedListMyTeams = cache(listMyTeams);
const cachedCountUnread = cache(countUnread);
const cachedCountGroupUnread = cache(countGroupUnread);
const cachedCountPendingGroupInvites = cache(countPendingGroupInvites);
const cachedCountUnreadSystemMessages = cache(countUnreadSystemMessages);
const cachedListMyUpcomingMilestones = cache(listMyUpcomingMilestones);
const cachedListMyTeamResourceUsages = cache(listMyTeamResourceUsages);
const cachedListMyRecentAttachments = cache(listMyRecentAttachments);
/** 供 (app) 布局在读取常驻栏默认布局时共用同一份缓存 */
export const getApproverStatus = cache(isApproverAnywhere);
const cachedIsApproverAnywhere = getApproverStatus;
const cachedListPendingApprovalsForApprover = cache(listPendingApprovalsForApprover);
const cachedListMyTaskPlans = cache(listMyTaskPlans);
const cachedListMySubtaskProgress = cache(listMySubtaskProgress);
const cachedListMyTaskApprovalSummaries = cache(listMyTaskApprovalSummaries);

export type DashboardDataOptions = {
  /** 看板「隐藏已完成」（来自工作台的查询参数；常驻栏不用） */
  hideDone?: boolean;
  /** 看板项目筛选（来自查询参数；常驻栏不用） */
  project?: string | null;
  /** 只加载这些卡片类型需要的数据；缺省 = 全量（工作台） */
  only?: readonly DashboardWidgetId[];
};

export async function loadDashboardData(
  userId: string,
  opts: DashboardDataOptions = {},
): Promise<DashboardData> {
  const { only } = opts;
  const needs = (type: DashboardWidgetId) => only === undefined || only.includes(type);

  const needTasks =
    needs("task_board") ||
    needs("schedule") ||
    needs("upcoming") ||
    STAT_WIDGET_IDS.some((id) => needs(id));
  const needFeed = needs("activity_feed");
  const needMessages = needs("unread_messages");
  const needTz =
    needTasks ||
    needFeed ||
    // 里程碑卡用 today 判断「还有几天」，必须按用户时区算
    needs("milestones") ||
    needs("resource_usage") ||
    needs("recent_attachments") ||
    needs("approvals") ||
    needs("clock") ||
    needs("countdown");

  const [
    myTasks,
    feed,
    feedUnread,
    projects,
    teams,
    dmUnread,
    groupUnread,
    pendingInvites,
    systemUnread,
    tz,
    milestoneRows,
    resourceUsages,
    attachments,
    isApprover,
    pendingApprovals,
  ] = await Promise.all([
    needTasks ? cachedListMyTasks(userId) : [],
    needFeed ? cachedListMyTaskActivities(userId) : [], // 全量口径，不受任何筛选影响
    needFeed ? cachedGetFeedUnreadCount(userId, WORKBENCH_SCOPE) : 0,
    needs("my_projects") ? cachedListMyProjects(userId) : [],
    needs("my_teams") ? cachedListMyTeams(userId) : [],
    needMessages ? cachedCountUnread(userId) : 0,
    needMessages ? cachedCountGroupUnread(userId) : 0,
    needMessages ? cachedCountPendingGroupInvites(userId) : 0,
    needMessages ? cachedCountUnreadSystemMessages(userId) : 0,
    needTz ? resolveUserTimeZone(userId) : "UTC",
    needs("milestones") ? cachedListMyUpcomingMilestones(userId) : [],
    needs("resource_usage") ? cachedListMyTeamResourceUsages(userId) : [],
    needs("recent_attachments") ? cachedListMyRecentAttachments(userId) : [],
    // 「恢复默认」的变体取决于它；查询很轻，一律取
    cachedIsApproverAnywhere(userId),
    needs("approvals") ? cachedListPendingApprovalsForApprover(userId) : [],
  ]);

  // 个人计划段：本人对这些任务自记的「打算什么时候做」（可多段区间或单天），供日程表日历编辑/展示
  const taskIds = myTasks.map((t) => t.id);
  const [plans, progressRows, approvalSummaries] = needTasks
    ? await Promise.all([
        cachedListMyTaskPlans(userId, taskIds),
        cachedListMySubtaskProgress(taskIds),
        cachedListMyTaskApprovalSummaries(userId, taskIds),
      ])
    : [{}, [], new Map()];

  // 「今天 / 本周截止」一律按**用户自己的时区**在服务端算成 YYYY-MM-DD，
  // 再由服务端传给看板 —— 客户端不取时钟，免得同一个人在两处看到不同的「今天」。
  // 周日的算法也走日历字符串（addDays），不要用 setDate：那会把宿主时区绕回来。
  const now = new Date();
  const today = todayIn(tz, now);
  const weekEnd = addDays(today, (7 - weekdayOfDate(today)) % 7);

  // 子任务进度合并进卡片数据（只认直接子级聚合的父 id）
  const byParent = new Map(
    progressRows.flatMap((r) => (r.parentTaskId ? [[r.parentTaskId, r] as const] : [])),
  );
  // 我名下任务的完成审批状态（作为申请人的最近一次）：卡片渲染醒目徽章，点开看详情
  const enriched: WorkbenchTask[] = myTasks.map((t) => {
    const p = byParent.get(t.id);
    const a = approvalSummaries.get(t.id);
    return {
      ...t,
      ...(p ? { subTotal: p.total, subDone: p.done } : {}),
      ...(a
        ? {
            approvalStatus: a.status,
            approvalApproverName: a.approverName,
            approvalDecidedAt: a.decidedAt,
            approvalRequestedAt: a.createdAt,
          }
        : {}),
    };
  });

  // 筛选管线：统计/动态流用全量；看板先过项目再过 hideDone
  const hideDone = opts.hideDone ?? false;
  const projectFilter = pickProjectFilter(opts.project ?? undefined, myTasks);
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

  return {
    isApprover,
    visibleTasks,
    plans,
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
    messages: {
      dm: dmUnread,
      group: groupUnread,
      invites: pendingInvites,
      system: systemUnread,
    },
    // 查询里已过滤掉空日期，这里只是把可空类型收窄
    milestones: milestoneRows.map((m) => ({
      id: m.id,
      title: m.title,
      targetDate: m.targetDate as string,
      projectId: m.projectId,
      projectName: m.projectName,
    })),
    resourceUsages,
    attachments,
    approvals: pendingApprovals,
  };
}
