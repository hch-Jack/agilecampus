// 服务端页面 → 客户端网格的卡片数据。刻意只带渲染必需的字段：
// 团队邀请码、项目创建时间等一概不传，别让它们出现在 RSC 载荷里。
import type { ActivityFeedRow } from "@/components/activity-feed";
import type { WorkbenchTask } from "./workbench-board";
import type { WorkbenchStats } from "@/lib/workbench-stats";

export type DashboardProject = {
  id: string;
  name: string;
  teamName: string;
  status: string;
  taskTotal: number;
  doneCount: number;
};

export type DashboardTeam = {
  id: string;
  name: string;
  role: "admin" | "teacher" | "student";
  counts: { projects: number; milestones: number; tasks: number; members: number };
};

export type DashboardUpcoming = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  dueDate: string;
};

export type DashboardMessages = {
  dm: number;
  group: number;
  invites: number;
};

/** 整页一次性装配的数据；加卡不需要再请求服务端 */
export type DashboardData = {
  visibleTasks: WorkbenchTask[];
  doneCount: number;
  hideDone: boolean;
  projectFilter: string | null;
  chips: { id: string; name: string }[];
  stats: WorkbenchStats;
  today: string;
  feed: ActivityFeedRow[];
  feedUnread: number;
  feedScope: string;
  tz: string;
  now: Date;
  projects: DashboardProject[];
  teams: DashboardTeam[];
  upcoming: DashboardUpcoming[];
  messages: DashboardMessages;
};
