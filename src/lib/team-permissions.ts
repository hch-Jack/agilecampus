/**
 * 团队审批权限：三按一勾的模型（权限页给每个成员勾选）。
 *
 * - task_done   审核任务完成申请
 * - resource    审核资源占用
 * - project     审核项目结题验收（含在项目页直接结题）
 *
 * 有效权限 = admin 角色（天然全有，防唯一管理员把自己锁死）或对应勾选值。
 * 审批权从「角色」改为「按人授予」：老师不再因角色自动拥有审批权，由管理员显式勾选。
 */
import { and, eq } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import { teamMembers, users, type TeamRole } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getTeamMembership } from "./team";

// 权限短名：server action 的入参枚举与权限页列头共用
export const TEAM_PERMISSIONS = ["task_done", "resource", "project"] as const;
export type TeamPermission = (typeof TEAM_PERMISSIONS)[number];

export const PERMISSION_LABELS: Record<TeamPermission, string> = {
  task_done: "审核任务完成申请",
  resource: "审核资源占用",
  project: "审核项目结题验收",
};

/** team_members 行上的三个权限列（getTeamMembership 返回整行，天然满足） */
type PermissionColumns = {
  canApproveTaskDone: boolean;
  canApproveResource: boolean;
  canAcceptProject: boolean;
};

const COLUMN_BY_PERMISSION: Record<TeamPermission, keyof PermissionColumns> = {
  task_done: "canApproveTaskDone",
  resource: "canApproveResource",
  project: "canAcceptProject",
};

export function effectivePermissions(role: TeamRole, cols: PermissionColumns) {
  if (role === "admin") return { taskDone: true, resource: true, project: true };
  return {
    taskDone: cols.canApproveTaskDone,
    resource: cols.canApproveResource,
    project: cols.canAcceptProject,
  };
}

export function hasPermission(
  role: TeamRole,
  cols: PermissionColumns,
  perm: TeamPermission,
): boolean {
  if (role === "admin") return true;
  return cols[COLUMN_BY_PERMISSION[perm]];
}

/** 我在本团队的有效权限；非成员返回 null */
export async function getMyPermissions(userId: string, teamId: string) {
  const m = await getTeamMembership(userId, teamId);
  if (!m) return null;
  return effectivePermissions(m.role, m);
}

/** 团队里拥有某权限的全部成员 id（admin 恒在其中）。审批提醒的收件人来源 */
export async function listPermissionHolders(
  teamId: string,
  perm: TeamPermission,
  exec: typeof db | DbTx = db,
): Promise<string[]> {
  const rows = await exec
    .select({
      userId: teamMembers.userId,
      role: teamMembers.role,
      canApproveTaskDone: teamMembers.canApproveTaskDone,
      canApproveResource: teamMembers.canApproveResource,
      canAcceptProject: teamMembers.canAcceptProject,
    })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
  return rows.filter((r) => hasPermission(r.role, r, perm)).map((r) => r.userId);
}

/** 权限页数据：成员名单 + 各自的有效权限（admin 已折算成全有） */
export async function listMembersWithPermissions(teamId: string) {
  const rows = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      identity: users.identity,
      role: teamMembers.role,
      canApproveTaskDone: teamMembers.canApproveTaskDone,
      canApproveResource: teamMembers.canApproveResource,
      canAcceptProject: teamMembers.canAcceptProject,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(teamMembers.createdAt);

  return rows.map((r) => {
    const eff = effectivePermissions(r.role, r);
    return { ...r, permissions: eff };
  });
}

/**
 * 勾选/取消一名成员的某项权限（仅团队 admin 可操作）。
 * admin 行不可改：其权限天然全有，勾选形同虚设，不如显式拒绝。
 */
export async function setMemberPermission(
  actorId: string,
  teamId: string,
  userId: string,
  perm: TeamPermission,
  value: boolean,
): Promise<void> {
  const me = await getTeamMembership(actorId, teamId);
  if (!me || me.role !== "admin") throw new ForbiddenError("仅团队管理员可调整权限");
  const target = await getTeamMembership(userId, teamId);
  if (!target) throw new AppError("该成员不在团队中");
  if (target.role === "admin") throw new AppError("管理员始终拥有全部权限，无须勾选");

  await db
    .update(teamMembers)
    .set({ [COLUMN_BY_PERMISSION[perm]]: value })
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)));
}
