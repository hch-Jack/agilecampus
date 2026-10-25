// 服务端页面 → 客户端网格的卡片数据。刻意只带渲染必需的字段：
// 团队邀请码、项目创建时间等一概不传，别让它们出现在 RSC 载荷里。
import type { ActivityFeedRow } from "@/components/activity-feed";
import type { WorkbenchTask } from "./workbench-board";
import type { WorkbenchStats } from "@/lib/workbench-stats";
import type { TaskPlanSegment } from "@/lib/task-plan";

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

/** 跨项目的待完成里程碑（按目标日期升序） */
export type DashboardMilestone = {
  id: string;
  title: string;
  targetDate: string;
  projectId: string;
  projectName: string;
};

/** 跨团队的资源占用（占用中优先，其后按开始时间倒序） */
export type DashboardResourceUsage = {
  id: string;
  teamId: string;
  teamName: string;
  resourceName: string;
  purpose: string | null;
  userName: string;
  startTime: Date;
  endTime: Date | null;
  active: boolean;
};

/** 跨项目的最新任务附件（不含文件内容） */
export type DashboardAttachment = {
  id: string;
  filename: string;
  mimeType: string | null;
  size: number;
  createdAt: Date;
  uploaderName: string | null;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
};

/** 我的团队里待我审批的申请（老师/管理员视角；学生恒为空数组） */
export type DashboardApproval = {
  id: string;
  type: "task_done" | "resource_usage";
  teamId: string;
  teamName: string;
  requesterName: string;
  taskId: string | null;
  taskTitle: string | null;
  projectId: string | null;
  resourceName: string | null;
  purpose: string | null;
  startTime: Date | null;
  endTime: Date | null;
  createdAt: Date;
};

/** 整页一次性装配的数据；加卡不需要再请求服务端 */
export type DashboardData = {
  visibleTasks: WorkbenchTask[];
  plans: Record<string, TaskPlanSegment[]>;
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
  milestones: DashboardMilestone[];
  resourceUsages: DashboardResourceUsage[];
  attachments: DashboardAttachment[];
  approvals: DashboardApproval[];
};
