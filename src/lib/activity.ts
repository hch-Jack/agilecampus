import { and, desc, eq, gt, notExists, sql } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import {
  activityHides,
  feedReads,
  projects,
  taskActivities,
  tasks,
  teamMembers,
  users,
} from "@/db/schema";
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

/**
 * 某用户自己隐藏掉的动态：`activity_hides` 里有一条即不可见。
 * 只影响本人，别人的查询照常；子查询引用外层 taskActivities.id。
 */
function notHiddenBy(actorId: string) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(activityHides)
      .where(
        and(
          eq(activityHides.activityId, taskActivities.id),
          eq(activityHides.userId, actorId),
        ),
      ),
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
  const clearedAfter = await feedClearedAfter(actorId, taskFeedScope(taskId));

  const rows = await db
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
    .where(
      and(
        eq(taskActivities.taskId, taskId),
        // 「清除记录」后的旧动态对本人隐藏（见 clearFeed），他人查询不受影响
        ...(clearedAfter ? [clearedAfter] : []),
        // 单条删除：只影响本人
        notHiddenBy(actorId),
      ),
    )
    .orderBy(desc(taskActivities.createdAt))
    .limit(limit);

  // 管理员可以全局删除，前端据此给出不同确认文案
  const canPurge = access.role === "admin";
  return rows.map((row) => ({ ...row, canPurge }));
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
  /** 团队管理员：删除会从所有人的动态流与库中移除；否则只对自己隐藏 */
  canPurge: boolean;
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
  const clearedAfter = await feedClearedAfter(actorId, WORKBENCH_SCOPE);
  const rows = await db
    .select({ ...feedColumns, role: teamMembers.role })
    .from(taskActivities)
    .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(users, eq(taskActivities.actorId, users.id))
    .innerJoin(
      teamMembers,
      and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, actorId)),
    )
    .where(
      and(
        eq(tasks.assigneeId, actorId),
        eq(projects.status, "active"),
        // 「清除记录」后的旧动态对本人隐藏（见 clearFeed），他人查询不受影响
        ...(clearedAfter ? [clearedAfter] : []),
        // 单条删除：只影响本人
        notHiddenBy(actorId),
      ),
    )
    // 同一事务写入的多条动态时间戳相同，二级键保证顺序确定
    .orderBy(desc(taskActivities.createdAt), desc(taskActivities.id))
    .limit(limit);

  return rows.map(({ role, ...row }) => ({ ...row, canPurge: role === "admin" }));
}

// 项目页「最新记录」：该项目的全部任务动态（不限「分配给我」），最新在前。
// 与工作台口径不同：不筛 assignee 也不筛 active——能打开项目页即已通过访问校验，
// 归档项目照常可读历史动态，与任务详情时间线口径一致。
export async function listProjectActivities(
  actorId: string,
  projectId: string,
  limit = 20,
  taskId?: string,
): Promise<TaskActivityRow[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  const clearedAfter = await feedClearedAfter(actorId, projectFeedScope(projectId));

  const rows = await db
    .select(feedColumns)
    .from(taskActivities)
    .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
    .innerJoin(projects, eq(tasks.projectId, projects.id))
    .innerJoin(users, eq(taskActivities.actorId, users.id))
    .where(
      and(
        eq(tasks.projectId, projectId),
        // 助手按任务追问时只取该任务；项目页/任务页的既有调用不传
        ...(taskId ? [eq(taskActivities.taskId, taskId)] : []),
        // 「清除记录」后的旧动态对本人隐藏（见 clearFeed），他人查询不受影响
        ...(clearedAfter ? [clearedAfter] : []),
        // 单条删除：只影响本人
        notHiddenBy(actorId),
      ),
    )
    .orderBy(desc(taskActivities.createdAt), desc(taskActivities.id))
    .limit(limit);

  const canPurge = access.role === "admin";
  return rows.map((row) => ({ ...row, canPurge }));
}

// 某用户在某 scope 的「清除」时刻（无 = 未清除过），返回可直接拼进 WHERE 的比较条件。
// 比较必须留在 SQL 里：时刻读到 JS（Date 只有毫秒精度）再当参数传回去会丢微秒，
// 「清除前同一毫秒内」的动态会被漏成可见（CI 上偶发挂掉的 clearFeed 用例即此因）。
async function feedClearedAfter(actorId: string, scope: string) {
  const [row] = await db
    .select({ clearedAt: feedReads.clearedAt })
    .from(feedReads)
    .where(and(eq(feedReads.userId, actorId), eq(feedReads.scope, scope)));
  if (!row?.clearedAt) return null;
  return gt(
    taskActivities.createdAt,
    sql`(select cleared_at from feed_reads where user_id = ${actorId} and scope = ${scope})`,
  );
}

// -------------------------------------------------------------------- 未读

// 动态流 scope：工作台、项目页、任务页各记各的已读标记，互不影响
export const WORKBENCH_SCOPE = "workbench";
export function projectFeedScope(projectId: string) {
  return `project:${projectId}`;
}
export function taskFeedScope(taskId: string) {
  return `task:${taskId}`;
}
// server action 入口的白名单校验：scope 只能由这三者拼出，防脏数据行
export function isFeedScopeValid(scope: string) {
  return (
    scope === WORKBENCH_SCOPE ||
    /^(project|task):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(scope)
  );
}

// 未读数 = 该 scope 动态流中 createdAt 晚于已读标记的条数。
// 口径与对应 feed 查询一致（workbench 限「分配给我」的 active 项目；project 限该项目；task 限该任务）。
// 没有标记 = 视为全部已读：功能上线时不给存量用户灌一屏未读。
export async function getFeedUnreadCount(actorId: string, scope: string): Promise<number> {
  const [marker] = await db
    .select({ lastReadAt: feedReads.lastReadAt })
    .from(feedReads)
    .where(and(eq(feedReads.userId, actorId), eq(feedReads.scope, scope)));
  if (!marker) return 0;

  // 与库里的已读时刻原值比较（子查询不经过 JS）：marker 读到 JS 再当参数传回
  // 会丢微秒精度，「标记已读前同一毫秒内」的动态会被漏计成未读（角标清不掉）
  const afterMarker = gt(
    taskActivities.createdAt,
    sql`(select last_read_at from feed_reads where user_id = ${actorId} and scope = ${scope})`,
  );

  let row: { n: number };
  if (scope === WORKBENCH_SCOPE) {
    [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskActivities)
      .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .innerJoin(
        teamMembers,
        and(eq(teamMembers.teamId, projects.teamId), eq(teamMembers.userId, actorId)),
      )
      .where(
        and(
          afterMarker,
          eq(tasks.assigneeId, actorId),
          eq(projects.status, "active"),
          notHiddenBy(actorId),
        ),
      );
  } else if (scope.startsWith("project:")) {
    [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskActivities)
      .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
      .innerJoin(projects, eq(tasks.projectId, projects.id))
      .where(
        and(
          afterMarker,
          eq(tasks.projectId, scope.slice("project:".length)),
          notHiddenBy(actorId),
        ),
      );
  } else {
    // task: 只数该任务自己的动态，无需 join
    [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(taskActivities)
      .where(
        and(
          afterMarker,
          eq(taskActivities.taskId, scope.slice("task:".length)),
          notHiddenBy(actorId),
        ),
      );
  }

  return row.n;
}

// 把已读标记推进到「现在」：此后新产生的动态重新计未读。
// lastReadAt 必须取数据库时钟（now()）：未读数要与动态的 createdAt（也是库内
// defaultNow）同源比较，取 Node 时钟的话宿主机与 PG 容器一漂移，未读数就会错。
export async function markFeedRead(actorId: string, scope: string): Promise<void> {
  await db
    .insert(feedReads)
    .values({ userId: actorId, scope, lastReadAt: sql`now()` })
    .onConflictDoUpdate({
      target: [feedReads.userId, feedReads.scope],
      set: { lastReadAt: sql`now()` },
    });
}

// 「清除记录」：只清空该用户**自己看到的**动态流——把清除时刻记成 cleared_at，
// 该 scope 的 feed 查询据此隐藏这一刻之前的记录，并顺手把未读归零。
// 库内数据与他人视图一律不动（人人可清、谁也不影响别人）；此后新产生的记录照常显示、照常计未读。
export async function clearFeed(actorId: string, scope: string): Promise<void> {
  await db
    .insert(feedReads)
    .values({ userId: actorId, scope, lastReadAt: sql`now()`, clearedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [feedReads.userId, feedReads.scope],
      set: { lastReadAt: sql`now()`, clearedAt: sql`now()` },
    });
}

/**
 * 删除单条动态。
 *
 * - 团队管理员：直接从 `task_activities` 删行，所有人与库一起消失；
 * - 其他成员：写一条 `activity_hides`，只从本人的动态流里隐藏，不动数据与他人视图。
 *
 * 权限口径与动态读权限一致：必须是该任务所属团队的成员。
 */
export type ActivityDeleteMode = "all" | "self";

export async function deleteActivityForUser(
  actorId: string,
  activityId: string,
): Promise<ActivityDeleteMode> {
  const [row] = await db
    .select({ projectId: tasks.projectId })
    .from(taskActivities)
    .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
    .where(eq(taskActivities.id, activityId));
  if (!row) throw new AppError("记录不存在");

  const access = await getProjectForUser(actorId, row.projectId);
  if (!access) throw new ForbiddenError();

  if (access.role === "admin") {
    await db.delete(taskActivities).where(eq(taskActivities.id, activityId));
    return "all";
  }

  await db
    .insert(activityHides)
    .values({ userId: actorId, activityId })
    .onConflictDoNothing();
  return "self";
}
