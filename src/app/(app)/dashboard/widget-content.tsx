"use client";

// 卡片内容渲染：工作台与常驻栏共用同一份 switch，避免两边行为漂移。
import type { ReactNode } from "react";
import type { DashboardLayoutItem, DashboardWidgetId } from "@/lib/dashboard-layout";
import type { WorkbenchStatKey } from "@/lib/workbench-stats";
import { ActivityFeed } from "@/components/activity-feed";
import type { DashboardData } from "./dashboard-types";
import { WorkbenchBoard } from "./workbench-board";
import { WorkbenchSchedule } from "./workbench-schedule";
import { StatWidget } from "./widgets/stats";
import {
  MessagesWidget,
  MyProjectsWidget,
  MyTeamsWidget,
  QuickLinksWidget,
  UpcomingWidget,
} from "./widgets/lists";
import {
  ClockWidget,
  CountdownWidget,
  NoteWidget,
  type ConfigChange,
} from "./widgets/personal";
import {
  FocusTimerWidget,
  MilestonesWidget,
  RecentAttachmentsWidget,
  ResourceUsageWidget,
} from "./widgets/productivity";
import { ApprovalsWidget } from "./widgets/approvals";

const STAT_KEYS: Partial<Record<DashboardWidgetId, WorkbenchStatKey>> = {
  stat_overdue: "overdue",
  stat_today: "today",
  stat_week: "week",
  stat_doing: "doing",
};

/** `editing` 仅用于看板锁列：编辑网格时别让卡内拖拽与卡片拖动抢指针 */
export function renderWidgetContent(
  item: DashboardLayoutItem,
  data: DashboardData,
  editing: boolean,
  onConfigChange: (id: string) => ConfigChange,
): ReactNode {
  const statKey = STAT_KEYS[item.type];
  if (statKey) return <StatWidget statKey={statKey} value={data.stats[statKey]} />;

  switch (item.type) {
    case "task_board":
      return (
        <WorkbenchBoard
          tasks={data.visibleTasks}
          today={data.today}
          timeZone={data.tz}
          doneCount={data.doneCount}
          hideDone={data.hideDone}
          chips={data.chips}
          projectFilter={data.projectFilter}
          locked={editing}
        />
      );
    case "schedule":
      return (
        <WorkbenchSchedule
          tasks={data.visibleTasks}
          plans={data.plans}
          today={data.today}
          config={item.config}
          onConfigChange={onConfigChange(item.id)}
        />
      );
    case "activity_feed":
      return (
        <ActivityFeed
          activities={data.feed}
          tz={data.tz}
          now={data.now}
          showProject
          unreadScope={data.feedScope}
          unreadCount={data.feedUnread}
          clearScope={data.feedScope}
          embedded
          fill
        />
      );
    case "my_projects":
      return <MyProjectsWidget projects={data.projects} />;
    case "upcoming":
      return <UpcomingWidget tasks={data.upcoming} today={data.today} />;
    case "my_teams":
      return <MyTeamsWidget teams={data.teams} />;
    case "unread_messages":
      return <MessagesWidget messages={data.messages} />;
    case "quick_links":
      return <QuickLinksWidget />;
    case "milestones":
      return <MilestonesWidget milestones={data.milestones} today={data.today} />;
    case "resource_usage":
      return <ResourceUsageWidget usages={data.resourceUsages} tz={data.tz} />;
    case "recent_attachments":
      return <RecentAttachmentsWidget attachments={data.attachments} tz={data.tz} />;
    case "approvals":
      return <ApprovalsWidget approvals={data.approvals} tz={data.tz} />;
    case "focus_timer":
      return <FocusTimerWidget instanceId={item.id} />;
    case "note":
      return <NoteWidget config={item.config} onConfigChange={onConfigChange(item.id)} />;
    case "clock":
      return (
        <ClockWidget tz={data.tz} config={item.config} onConfigChange={onConfigChange(item.id)} />
      );
    case "countdown":
      return (
        <CountdownWidget
          tz={data.tz}
          config={item.config}
          onConfigChange={onConfigChange(item.id)}
        />
      );
    default:
      return null;
  }
}
