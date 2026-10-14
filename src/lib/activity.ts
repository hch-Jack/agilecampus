import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import { feedReads, projects, taskActivities, tasks, teamMembers, users } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser } from "./project";

// 任务动态：由 lib/task.ts 与 lib/attachment.ts 的写操作埋点调用，
// 与主操作同库（传入事务 exec 时同事务写入），失败即随主操作一起回滚。

export type TaskActivityInput = {
  taskId: string;
  actorId: string;
  type: string; // created | field | subtask_added | subtask_done | subtask_reopened | subtask_deleted | attachment_added | attachment_deleted
  field?: string;
  oldValue?: string | null;
  newValue?: string | null;
};

export async function recordTaskActivity(
  exec: typeof db | DbTx,
  rows: TaskActivityInput[],
) {
  if (rows.length === 0) return;
  await exec.insert(taskActivities).values(
    rows.map((r) => ({
      taskId: r.taskId,
      actorId: r.actorId,
      type: r.type,
      field: r.field ?? null,
      oldValue: r.oldValue ?? null,
      newValue: r.newValue ?? null,
    })),
  );
}

// 任务时间线：谁在何时做了什么，倒序，默认最近 50 条。项目成员即可读。
export async function listTaskActivities(actorId: string, taskId: string, limit = 50) {
  const [task] = await db
    .select({ projectId: tasks.projectId })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");
  const access = await getProjectForUser(actorId, task.projectId);
  if (!access) throw new ForbiddenError();

  return db
    .select({
      id: taskActivities.id,
      actorName: users.name,
      type: taskActivities.type,
      field: taskActivities.field,
      oldValue: taskActivities.oldValue,
      newValue: taskActivities.newValue,
      createdAt: taskActivities.createdAt,
    })
    .from(taskActivities)
    .innerJoin(users, eq(taskActivities.actorId, users.id))
    .where(eq(taskActivities.taskId, taskId))
    .orderBy(desc(taskActivities.createdAt))
    .limit(limit);
}

// 工作台与项目页共用的「动态流」行结构，两条查询共享同一投影，保证行结构一致。
export type TaskActivityRow = {
  id: string;
  taskId: string;
  taskTitle: string;
  projectId: string;
  projectName: string;
  actorName: string;
  type: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
};

const feedColumns = {
  id: taskActivities.id,
  taskId: tasks.id,
  taskTitle: tasks.title,
  projectId: projects.id,
  projectName: projects.name,
  actorName: users.name,
  type: taskActivities.type,
  field: taskActivities.field,
  oldValue: taskActivities.oldValue,
  newValue: taskActivities.newValue,
  createdAt: taskActivities.createdAt,
};

// 工作台「最近动静」：当前分配给我的任务（active 项目、我仍是成员）的全部动态，最新在前。
// 口径说明：改派后任务的历史动态会离开我的 feed（按「当前分配」过滤）；任务删除时动态级联自净；
// 标题/项目名取当前值。相对时间文案的前提是 PG 与 Node 时区一致（部署时两侧须对齐）。
export async function listMyTaskActivities(
  actorId: string,
  limit = 20,
): Promise<TaskActivityRow[]> {
  return db
    .select(feedColumns)
    .from(taskActivities)
    .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(users, eq(taskActivities.actorId, users.id))
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, actorId)),
    )
    .where(and(eq(tasks.assigneeId, actorId), eq(projects.status, "active")))
    // 同一事务写入的多条动态时间戳相同，二级键保证顺序确定
    .orderBy(desc(taskActivities.createdAt), desc(taskActivities.id))
    .limit(limit);
}

// 项目页「最新记录」：该项目的全部任务动态（不限「分配给我」），最新在前。
// 与工作台口径不同：不筛 assignee 也不筛 active——能打开项目页即已通过访问校验，
// 归档项目照常可读历史动态，与任务详情时间线口径一致。
export async function listProjectActivities(
  actorId: string,
  projectId: string,
  limit = 20,
): Promise<TaskActivityRow[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  return db
    .select(feedColumns)
    .from(taskActivities)
    .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(users, eq(taskActivities.actorId, users.id))
    .where(eq(tasks.projectId, projectId))
    .orderBy(desc(taskActivities.createdAt), desc(taskActivities.id))
    .limit(limit);
}

// -------------------------------------------------------------------- 未读

// 动态流 scope：工作台与项目页各记各的已读标记，互不影响
export const WORKBENCH_SCOPE = "workbench";
export function projectFeedScope(projectId: string) {
  return `project:${projectId}`;
}
// server action 入口的白名单校验：scope 只能由这两者拼出，防脏数据行
export function isFeedScopeValid(scope: string) {
  return (
    scope === WORKBENCH_SCOPE ||
    /^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope)
  );
}

// 未读数 = 该 scope 动态流中 createdAt 晚于已读标记的条数。
// 口径与对应 feed 查询一致（workbench 限「分配给我」的 active 项目；project 限该项目）。
// 没有标记 = 视为全部已读：功能上线时不给存量用户灌一屏未读。
export async function getFeedUnreadCount(actorId: string, scope: string): Promise<number> {
  const [marker] = await db
    .select({ lastReadAt: feedReads.lastReadAt })
    .from(feedReads)
    .where(and(eq(feedReads.userId, actorId), eq(feedReads.scope, scope)));
  if (!marker) return 0;

  const afterMarker = gt(taskActivities.createdAt, marker.lastReadAt);

  const [row] =
    scope === WORKBENCH_SCOPE
      ? await db
          .select({ n: sql<number>`count(*)::int` })
          .from(taskActivities)
          .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
          .innerJoin(projects, eq(tasks.projectId, projects.id))
          .innerJoin(
            teamMembers,
            and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, actorId)),
          )
          .where(and(afterMarker, eq(tasks.assigneeId, actorId), eq(projects.status, "active")))
      : await db
          .select({ n: sql<number>`count(*)::int` })
          .from(taskActivities)
          .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
          .innerJoin(projects, eq(tasks.projectId, projects.id))
          .where(and(afterMarker, eq(tasks.projectId, scope.slice("project:".length))));

  return row.n;
}

// 把已读标记推进到「现在」：此后新产生的动态重新计未读
export async function markFeedRead(actorId: string, scope: string): Promise<void> {
  await db
    .insert(feedReads)
    .values({ userId: actorId, scope, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [feedReads.userId, feedReads.scope],
      set: { lastReadAt: new Date() },
    });
}
