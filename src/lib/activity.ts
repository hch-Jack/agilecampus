import { and, desc, eq } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import { projects, taskActivities, tasks, teamMembers, users } from "@/db/schema";
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

// 工作台「最近动静」：当前分配给我的任务（active 项目、我仍是成员）的全部动态，最新在前。
// 口径说明：改派后任务的历史动态会离开我的 feed（按「当前分配」过滤）；任务删除时动态级联自净；
// 标题/项目名取当前值。相对时间文案的前提是 PG 与 Node 时区一致（部署时两侧须对齐）。
export type MyTaskActivityRow = {
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

export async function listMyTaskActivities(
  actorId: string,
  limit = 20,
): Promise<MyTaskActivityRow[]> {
  return db
    .select({
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
    })
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
