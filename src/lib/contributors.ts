/**
 * 项目成员贡献度：每人一行，反映「负责任务的程度」。
 *
 * 口径（含子任务，子任务负责人算完成贡献；顶层与子任务都计入）：
 * - 在办/完成/按时完成：按任务当前 assignee + 完成动态时间归属到人
 *   （任务转交后历史完成仍归原完成者；动态缺失的完成按 updatedAt 兜底）
 * - 创建：谁拆解组织（created 动态的 actor）
 * - 动态活跃度：字段变更/子任务增删/附件增删等过程参与（created 不重复计）
 * - 最近活动：该成员最近一次任何动态的时间
 *
 * 有意不合成「贡献总分」：任务有轻重，加权评分是人为拍脑袋；各项独立呈现。
 * 完全无任务且无动态的成员不出行（零行数据无信息量）。
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { taskActivities, tasks, teamMembers, users } from "@/db/schema";
import { getProjectForUser } from "./project";
import { ForbiddenError } from "./errors";
import { dateIn } from "./time";
import { resolveUserTimeZone } from "./time-pref";

export type ContributorRow = {
  userId: string;
  name: string;
  identity: "teacher" | "student" | null;
  role: "admin" | "teacher" | "student";
  /** 当前在办（未完成，负责人是自己） */
  active: number;
  /** 完成（含子任务，按完成时点归属） */
  done: number;
  /** 完成 / (完成+在办)；分母为 0 时 null（显示 —） */
  completionRate: number | null;
  /** 完成且 ≤ dueDate 的比例；无法判定（缺截止/缺完成时间）的不计入分母 */
  onTimeRate: number | null;
  /** 拆解组织：created 动态计数 */
  created: number;
  /** 过程参与：field、subtask 增删改、附件增删等动态计数 */
  activityCount: number;
  /** 最近一次动态的日期（用户时区 YYYY-MM-DD），无动态为 null */
  lastActiveDay: string | null;
};

const DONE_TEXT = "已完成";

export async function listProjectContributors(
  actorId: string,
  projectId: string,
): Promise<{ rows: ContributorRow[]; todayDay: string; projectName: string }> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  const tz = await resolveUserTimeZone(actorId);

  // 项目全部任务（含子任务）：当前 assignee + dueDate + updatedAt
  const taskRows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      assigneeId: tasks.assigneeId,
      dueDate: tasks.dueDate,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(eq(tasks.projectId, projectId));

  // 全部相关动态（created 判完成归属之外，一切计数按 actor）
  const activityRows = await db
    .select({
      actorId: taskActivities.actorId,
      type: taskActivities.type,
      field: taskActivities.field,
      oldValue: taskActivities.oldValue,
      newValue: taskActivities.newValue,
      at: taskActivities.createdAt,
      taskId: taskActivities.taskId,
    })
    .from(taskActivities)
    .innerJoin(tasks, eq(taskActivities.taskId, tasks.id))
    .where(and(eq(tasks.projectId, projectId), isNotNull(taskActivities.actorId)))
    .orderBy(desc(taskActivities.createdAt));

  // 项目所在团队的全部成员（含没干活的，供过滤后仍可对齐身份/角色）
  const members = await db
    .select({
      userId: teamMembers.userId,
      role: teamMembers.role,
      name: users.name,
      identity: users.identity,
    })
    .from(teamMembers)
    .innerJoin(users, eq(teamMembers.userId, users.id))
    .where(eq(teamMembers.teamId, access.project.teamId));

  // —— 完成归属：某任务最后一次「→已完成」动态的 actor 与时间 ——
  const doneByTask = new Map<string, { actorId: string; at: Date }>();
  for (const a of activityRows) {
    if (a.newValue !== DONE_TEXT) continue;
    const prev = doneByTask.get(a.taskId);
    // 动态按时间倒序取，首见即最新
    if (!prev) doneByTask.set(a.taskId, { actorId: a.actorId, at: a.at });
  }

  // —— 指标聚合 ——
  const agg = new Map<string, Omit<ContributorRow, "name" | "identity" | "role" | "userId" | "completionRate" | "onTimeRate">>();
  const ensure = (userId: string) => {
    let a = agg.get(userId);
    if (!a) {
      a = { active: 0, done: 0, created: 0, activityCount: 0, lastActiveDay: null };
      agg.set(userId, a);
    }
    return a;
  };

  for (const t of taskRows) {
    if (t.status === "done") {
      // 完成归属：完成动态的 actor；动态缺失（存量数据）退回当前负责人
      const owner = doneByTask.get(t.id)?.actorId ?? t.assigneeId;
      if (owner) ensure(owner).done += 1;
    } else if (t.assigneeId) {
      ensure(t.assigneeId).active += 1;
    }
  }

  for (const a of activityRows) {
    const g = ensure(a.actorId);
    if (a.type === "created") g.created += 1;
    else g.activityCount += 1;
    const day = dateIn(tz, a.at);
    if (!g.lastActiveDay || day > g.lastActiveDay) g.lastActiveDay = day;
  }

  // —— 按时完成：完成时点 ≤ dueDate（缺截止或缺完成时间的任务不计入分母）——
  const onTime = new Map<string, { hit: number; total: number }>();
  for (const t of taskRows) {
    if (t.status !== "done" || !t.dueDate) continue;
    const owner = doneByTask.get(t.id);
    if (!owner) continue; // 无法判定完成时点的不计入
    const b = onTime.get(owner.actorId) ?? { hit: 0, total: 0 };
    b.total += 1;
    if (dateIn(tz, owner.at) <= t.dueDate) b.hit += 1;
    onTime.set(owner.actorId, b);
  }

  const rows: ContributorRow[] = [];
  for (const m of members) {
    const a = agg.get(m.userId);
    // 完全没参与的成员不出行
    if (!a) continue;
    const doneTotal = a.done + a.active;
    const o = onTime.get(m.userId);
    rows.push({
      userId: m.userId,
      name: m.name,
      identity: m.identity,
      role: m.role,
      active: a.active,
      done: a.done,
      completionRate: doneTotal > 0 ? a.done / doneTotal : null,
      onTimeRate: o && o.total > 0 ? o.hit / o.total : null,
      created: a.created,
      activityCount: a.activityCount,
      lastActiveDay: a.lastActiveDay,
    });
  }
  // 贡献大的一般在前：完成数 → 创建数 → 动态数；但无名次号（不是排行榜）
  rows.sort((x, y) => y.done - x.done || y.created - x.created || y.activityCount - x.activityCount);

  return { rows, todayDay: dateIn(tz, new Date()), projectName: access.project.name };
}
