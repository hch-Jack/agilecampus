import { and, eq, isNotNull, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { tasks, users, projects } from "@/db/schema";
import { FARTHEST_EAST_TIMEZONE, addDays, resolveTimeZone, todayIn } from "./time";
import { sendCardMessage } from "./feishu";
import {
  buildAssignedCard,
  buildCompletedCard,
  buildDueReminderCard,
  type CardTask,
  type ReminderItem,
} from "./feishu-card";

// notify 收的 task 来自 createTask/updateTask 返回 row，含 projectId/priority
type TaskRow = {
  id: string;
  title: string;
  dueDate: string | null;
  assigneeId: string | null;
  projectId: string;
  priority: string;
  completionNote?: string | null;
  createdById?: string | null;
};

// 取用户 open_id（未绑返回 null）
async function openIdOf(userId: string): Promise<string | null> {
  const [row] = await db.select({ openId: users.feishuOpenId }).from(users).where(eq(users.id, userId));
  return row?.openId ?? null;
}

// 补查卡片所需的 项目名 / 负责人名
async function enrich(task: TaskRow): Promise<CardTask> {
  const [proj] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, task.projectId));
  let assigneeName: string | null = null;
  if (task.assigneeId) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, task.assigneeId));
    assigneeName = u?.name ?? null;
  }
  return {
    id: task.id,
    title: task.title,
    projectId: task.projectId,
    projectName: proj?.name ?? "（未知项目）",
    assigneeName,
    dueDate: task.dueDate,
    priority: task.priority,
    completionNote: task.completionNote ?? null,
  };
}

// 统一发送：失败仅记日志，绝不抛（fire-and-forget，通知不得阻断主业务）
async function safeSend(openId: string, card: unknown): Promise<boolean> {
  try {
    await sendCardMessage(openId, card);
    return true;
  } catch (e) {
    console.error("[notify] 飞书发送失败", e);
    return false;
  }
}

export async function notifyTaskAssigned(task: TaskRow): Promise<void> {
  if (!task.assigneeId) return;
  const openId = await openIdOf(task.assigneeId);
  if (!openId) return;
  await safeSend(openId, buildAssignedCard(await enrich(task)));
}

/**
 * 完成通知：优先知会交办人（创建者）。
 *
 * 创建者自己点的完成（单人团队里这是常态）不再静默——改发给负责人，
 * 让「完成」这件事至少留下一封回执。从前这里直接 return，于是用户建了自己的任务、
 * 自己标记完成，飞书里什么都没有，看起来像通知坏了。
 */
export async function notifyTaskCompleted(task: TaskRow, actorId: string): Promise<void> {
  const creatorId = task.createdById ?? null;
  const recipientId = creatorId && creatorId !== actorId ? creatorId : task.assigneeId;
  if (!recipientId) return;
  const openId = await openIdOf(recipientId);
  if (!openId) return;
  await safeSend(openId, buildCompletedCard(await enrich(task)));
}

/**
 * 扫全库临期(明日到期)+逾期(已过期未 done)，按负责人聚合为一封卡片日报。
 * 返回发送人数与扫描任务数（后者是**过筛后**真正进入日报条数，不是这条 SQL 取回的行数）。
 *
 * 「今天」按**负责人各自的时区**算 —— 提醒本来就该按收件人的日历日算：
 * 一个在 UTC 的人不该在北京时间的凌晨收到「今天到期」。
 *
 * cron 里没有浏览器，故偏好为 `auto` 的负责人按默认的中国时间算（`resolveTimeZone` 的兜底）。
 *
 * `at` 只为测试留出「现在」这个变量：分桶取决于各时区当天是几号，
 * 不把时刻钉住的话，用例只在一天里的某些钟点成立。
 */
export async function scanAndNotifyDue(
  at: Date = new Date(),
): Promise<{ notified: number; tasksScanned: number }> {
  // SQL 里的预过滤只能是**宽松上界**：各时区的「明天」不是同一天，取全球最东的那个，
  // 多取回一些行没关系，随后在 JS 里按各人时区精确过筛。
  // 这里以前是 `dueDate <= CURRENT_DATE + INTERVAL '1 day'`（DB 时区）紧配上
  // JS 里的 `toISOString()`（UTC）——两套日历口径打架，边界那天必然有人漏收或误收。
  const latestTomorrow = addDays(todayIn(FARTHEST_EAST_TIMEZONE, at), 1);

  const rows = await db
    .select({
      id: tasks.id,
      title: tasks.title,
      dueDate: tasks.dueDate,
      assigneeId: tasks.assigneeId,
      projectId: tasks.projectId,
      openId: users.feishuOpenId,
      assigneeTz: users.timezone,
    })
    .from(tasks)
    .innerJoin(users, eq(tasks.assigneeId, users.id))
    .where(
      and(
        ne(tasks.status, "done"),
        isNotNull(tasks.dueDate),
        isNotNull(users.feishuOpenId),
        lte(tasks.dueDate, latestTomorrow),
      ),
    );

  // 按负责人聚合。同一负责人的「今天」只算一次
  const byUser = new Map<string, { openId: string; overdue: ReminderItem[]; dueSoon: ReminderItem[] }>();
  const todayOf = new Map<string, string>();
  let scanned = 0;
  for (const r of rows) {
    if (!r.assigneeId || !r.openId || !r.dueDate) continue;

    let today = todayOf.get(r.assigneeId);
    if (today === undefined) {
      today = todayIn(resolveTimeZone(r.assigneeTz), at);
      todayOf.set(r.assigneeId, today);
    }
    // 对这个人而言还太远 —— SQL 那层只保证「对某个时区的人可能临期」
    if (r.dueDate > addDays(today, 1)) continue;

    const bucket = byUser.get(r.assigneeId) ?? { openId: r.openId, overdue: [], dueSoon: [] };
    const item: ReminderItem = { id: r.id, title: r.title, projectId: r.projectId };
    if (r.dueDate < today) bucket.overdue.push(item);
    else bucket.dueSoon.push(item);
    byUser.set(r.assigneeId, bucket);
    scanned++;
  }

  let notified = 0;
  for (const { openId, overdue, dueSoon } of byUser.values()) {
    const ok = await safeSend(openId, buildDueReminderCard({ overdue, dueSoon }));
    if (ok) notified++;
  }
  return { notified, tasksScanned: scanned };
}
