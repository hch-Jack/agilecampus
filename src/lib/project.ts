import { desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  milestones,
  projects,
  teamMembers,
  teams,
  tasks,
  type ProjectStatus,
} from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getTeamMembership, requireTeamRole } from "./team";

// YYYY-MM-DD 且为真实存在之日（2026-02-30 之类 Postgres 会拒并报 500，先在此拦成可读错误）
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 起止日期校验（lib 收口：Web 表单、Agent API、AI 落库三路皆汇聚于 createProject/updateProject）。
// 任一端给值先验格式；两端齐备才比先后——ISO 日期字典序即时间序，相等合法（当日项目）。
export function validateDateRange(startDate?: string | null, endDate?: string | null) {
  for (const d of [startDate, endDate]) {
    if (d && !isValidDate(d)) throw new AppError("日期格式不正确，须为 YYYY-MM-DD");
  }
  if (startDate && endDate && startDate > endDate)
    throw new AppError("开始日期不能晚于结束日期");
}

export async function createProject(
  actorId: string,
  teamId: string,
  input: {
    name: string;
    description?: string;
    startDate?: string;
    endDate?: string;
  },
) {
  await requireTeamRole(actorId, teamId, ["admin"]);
  validateDateRange(input.startDate, input.endDate);
  const [project] = await db
    .insert(projects)
    .values({
      teamId,
      name: input.name,
      description: input.description,
      startDate: input.startDate,
      endDate: input.endDate,
    })
    .returning();
  return project;
}

export async function listTeamProjects(actorId: string, teamId: string) {
  await requireTeamRole(actorId, teamId, ["admin", "teacher", "student"]);
  return db
    .select()
    .from(projects)
    .where(eq(projects.teamId, teamId))
    .orderBy(desc(projects.createdAt));
}

// 项目编辑/归档：仅团队 admin 可动（与 createProject 同一权限口径）
export async function updateProject(
  actorId: string,
  projectId: string,
  patch: {
    name?: string;
    description?: string | null;
    startDate?: string | null;
    endDate?: string | null;
    status?: ProjectStatus;
  },
) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  if (access.role !== "admin") throw new ForbiddenError();

  // 补丁触及起止日期时，与库中现有值合并后再校验——只改名的请求不受存量数据影响
  if (patch.startDate !== undefined || patch.endDate !== undefined) {
    validateDateRange(
      patch.startDate !== undefined ? patch.startDate : access.project.startDate,
      patch.endDate !== undefined ? patch.endDate : access.project.endDate,
    );
  }

  // 显式白名单构造，勿用 ...patch 展开：运行时宽对象可夹带 teamId 等越权字段（同 task.ts 之诫）
  const [updated] = await db
    .update(projects)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.startDate !== undefined && { startDate: patch.startDate }),
      ...(patch.endDate !== undefined && { endDate: patch.endDate }),
      ...(patch.status !== undefined && { status: patch.status }),
    })
    .where(eq(projects.id, projectId))
    .returning();
  if (!updated) throw new AppError("项目不存在");
  return updated;
}

// 项目详情聚合：项目本体 + 里程碑 + 任务状态计数。供 Agent API 一次取回全貌。
export async function getProjectDetail(actorId: string, projectId: string) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  const [projectMilestones, counts] = await Promise.all([
    listProjectMilestones(actorId, projectId),
    db
      .select({ status: tasks.status, count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .groupBy(tasks.status),
  ]);

  const byStatus = { todo: 0, doing: 0, done: 0 };
  for (const c of counts) byStatus[c.status] = c.count;

  return {
    project: access.project,
    role: access.role,
    milestones: projectMilestones,
    taskTotal: byStatus.todo + byStatus.doing + byStatus.done,
    byStatus,
  };
}

// 页面/任务层的访问收敛点：项目不存在或非团队成员一律 null，不泄露存在性
export async function getProjectForUser(actorId: string, projectId: string) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const membership = await getTeamMembership(actorId, project.teamId);
  if (!membership) return null;
  return { project, role: membership.role };
}

export async function createMilestone(
  actorId: string,
  projectId: string,
  input: { title: string; targetDate?: string },
) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access || access.role !== "admin") throw new ForbiddenError();
  const [milestone] = await db
    .insert(milestones)
    .values({ projectId, title: input.title, targetDate: input.targetDate })
    .returning();
  return milestone;
}

export async function listProjectMilestones(actorId: string, projectId: string) {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  return db
    .select()
    .from(milestones)
    .where(eq(milestones.projectId, projectId))
    .orderBy(milestones.targetDate);
}

// 跨团队聚合：我所在全部团队的项目 + 团队名 + 任务统计
export async function listMyProjects(actorId: string) {
  const memberships = await db
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.userId, actorId));
  const teamIds = memberships.map((m) => m.teamId);
  if (teamIds.length === 0) return [];

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      teamId: projects.teamId,
      teamName: teams.name,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .innerJoin(teams, eq(projects.teamId, teams.id))
    .where(inArray(projects.teamId, teamIds))
    .orderBy(desc(projects.createdAt));

  if (rows.length === 0) return [];

  const stats = await db
    .select({
      projectId: tasks.projectId,
      status: tasks.status,
      count: sql<number>`count(*)::int`,
    })
    .from(tasks)
    .where(
      inArray(
        tasks.projectId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(tasks.projectId, tasks.status);

  return rows.map((p) => {
    const mine = stats.filter((s) => s.projectId === p.id);
    const total = mine.reduce((n, s) => n + s.count, 0);
    const doneCount = mine.find((s) => s.status === "done")?.count ?? 0;
    return { ...p, taskTotal: total, doneCount };
  });
}
