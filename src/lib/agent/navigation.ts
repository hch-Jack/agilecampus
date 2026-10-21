import { getProjectForUser } from "@/lib/project";
import { getTeamForMember } from "@/lib/team";
import { getTaskDetail } from "@/lib/task";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { AssistantNavigation } from "./assistant-panel-shared";

/**
 * 助手「打开平台页面」。
 *
 * 模型只报**目标**（外加快照里的 id），不直接给 URL —— 页面白名单、id 取值与权限校验都在
 * 这里收口。否则模型一旦把路径写错，用户点开就是 404；给它自由拼 URL 更等于把路由表交给了它。
 *
 * 每个目标都先用现有 lib 校一次权限（项目成员 / 团队成员 / 任务可读），
 * 与读写工具的纵深防御同一个口径。
 */

export const NAV_TARGETS = [
  "dashboard",
  "projects",
  "teams",
  "messages",
  "settings",
  "project",
  "project_graph",
  "project_flow",
  "project_timeline",
  "task",
  "team_members",
  "team_projects",
  "team_resources",
  "team_labels",
] as const;

export type NavTarget = (typeof NAV_TARGETS)[number];

const STATIC_TARGETS: Partial<Record<NavTarget, AssistantNavigation>> = {
  dashboard: { label: "工作台", href: "/dashboard" },
  projects: { label: "所有项目", href: "/projects" },
  teams: { label: "我的团队", href: "/teams" },
  messages: { label: "消息", href: "/messages" },
  settings: { label: "AI 设置", href: "/settings" },
};

const PROJECT_TARGETS: Partial<Record<NavTarget, { suffix: string; label: string }>> = {
  project: { suffix: "", label: "" },
  project_graph: { suffix: "/graph", label: " · 关系图" },
  project_flow: { suffix: "/flow", label: " · 流程图" },
  project_timeline: { suffix: "/timeline", label: " · 时间线" },
};

const TEAM_TARGETS: Partial<Record<NavTarget, { seg: string; label: string }>> = {
  team_members: { seg: "members", label: "成员" },
  team_projects: { seg: "projects", label: "项目" },
  team_resources: { seg: "resources", label: "资源占用" },
  team_labels: { seg: "labels", label: "标签" },
};

export async function resolveNavigation(
  actorId: string,
  input: {
    target: NavTarget;
    projectId?: string;
    teamId?: string;
    taskId?: string;
  },
): Promise<AssistantNavigation> {
  const fixed = STATIC_TARGETS[input.target];
  if (fixed) return fixed;

  const projectTarget = PROJECT_TARGETS[input.target];
  if (projectTarget) {
    if (!input.projectId) {
      throw new AppError("打开项目页面需要 projectId（取自快照「我参与的项目」或 list_projects）");
    }
    const access = await getProjectForUser(actorId, input.projectId);
    if (!access) throw new ForbiddenError("项目不存在或无权访问");
    return {
      label: `${access.project.name}${projectTarget.label}`,
      href: `/projects/${input.projectId}${projectTarget.suffix}`,
    };
  }

  if (input.target === "task") {
    if (!input.taskId) {
      throw new AppError("打开任务页面需要 taskId（先 list_tasks / get_task_detail 取）");
    }
    const detail = await getTaskDetail(actorId, input.taskId);
    return {
      label: `任务「${detail.title}」`,
      href: `/projects/${detail.projectId}/tasks/${detail.id}`,
    };
  }

  const teamTarget = TEAM_TARGETS[input.target];
  if (teamTarget) {
    if (!input.teamId) {
      throw new AppError("打开团队页面需要 teamId（取自快照「我的团队」）");
    }
    const team = await getTeamForMember(actorId, input.teamId);
    return {
      label: `${team.name} · ${teamTarget.label}`,
      href: `/teams/${input.teamId}/${teamTarget.seg}`,
    };
  }

  // zod 的 enum 已挡住未知值；留个兜底，免得以后加了目标却忘记在此实现
  throw new AppError("不支持的页面");
}

/** 工具返回给编排器的信封：与草案卡一样带标记，便于从 toolResults 里捞出来 */
export type NavigationEnvelope = AssistantNavigation & { __navigate: true };

export function isNavigationEnvelope(value: unknown): value is NavigationEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __navigate?: unknown }).__navigate === true
  );
}
