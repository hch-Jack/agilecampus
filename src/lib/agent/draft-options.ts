import { getProjectForUser, listProjectMilestones } from "@/lib/project";
import { listProjectTasks } from "@/lib/task";
import { listTeamMembers } from "@/lib/team";
import type { DraftEnvelope } from "./tools";

/**
 * 草案卡片上那些下拉框的选项。
 *
 * 项目页的选项由页面直接查好（就那一个项目）；控制台助手的草案却可能指向**任意项目**，
 * 于是随响应一并算好 —— 少一次往返，也少一个需要单独鉴权的入口。
 *
 * 模型填了个无权限/不存在的 projectId 时**跳过**（而不是抛错）：卡片照样渲染出来，
 * 只是下拉里空着；落库时那道 `getProjectForUser` 重校才是真正的关卡。
 */

export type DraftOption = { id: string; name: string; parentTaskId?: string | null };
export type DraftOptions = {
  members: DraftOption[];
  milestones: DraftOption[];
  // 依赖卡要按 parentTaskId 只列「同级」候选；任务名沿用 title
  tasks: DraftOption[];
};

export async function collectDraftOptions(
  actorId: string,
  drafts: DraftEnvelope[],
): Promise<Record<string, DraftOptions>> {
  const projectIds = [
    ...new Set(
      drafts
        .map((d) => (d.draft as { projectId?: unknown } | null)?.projectId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ];

  const out: Record<string, DraftOptions> = {};
  await Promise.all(
    projectIds.map(async (projectId) => {
      const access = await getProjectForUser(actorId, projectId);
      if (!access) return;
      const [members, milestones, tasks] = await Promise.all([
        listTeamMembers(access.project.teamId),
        listProjectMilestones(actorId, projectId),
        listProjectTasks(actorId, projectId),
      ]);
      out[projectId] = {
        members: members.map((m) => ({ id: m.id, name: m.name })),
        milestones: milestones.map((m) => ({ id: m.id, name: m.title })),
        tasks: tasks.map((t) => ({ id: t.id, name: t.title, parentTaskId: t.parentTaskId })),
      };
    }),
  );
  return out;
}
