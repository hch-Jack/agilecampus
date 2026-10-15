import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { listMyProjects } from "@/lib/project";
import { listMyTasks } from "@/lib/task";
import { listMyTeams } from "@/lib/team";
import { listMyPersonalContext } from "@/lib/personal-context";
import { todayIn } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";

/**
 * 控制台助手（工作台）的快照 —— 与项目快照的分工：
 *
 * - **项目快照**（`snapshot.ts`）讲「这一个项目里有什么」，一切 id 都默认属于当前项目；
 * - **本文件的快照**讲「我是谁、我在哪些团队和项目里、我手上有什么」，于是**没有隐含项目**：
 *   凡是涉及具体项目的工具，参数里都必须显式给 projectId，而 projectId 只能取自下面两段
 *   （「我参与的项目」与「我的待办」）或 `list_projects` 工具。
 *
 * 本快照**只含本人数据**：团队是我所在的、项目是我能访问的、待办是分配给我的、上下文是我自己记的
 * （含标了「仅自己」的条目 —— 那是给自己看的助手，没有对外的道理）。取数全部走既有的按 actorId
 * 收敛的 lib，因此这里不需要额外的权限判断。
 */

// 与项目快照同一上限；超出时逐层降级（见文件末尾）
const SNAPSHOT_CHAR_LIMIT = 4000;
// 待办至多列此数，余者提示模型按项目现查
const TASK_LIST_LIMIT = 20;
// 我自己的上下文：条数与单条长度都收一收，免得它把待办段挤掉
const CONTEXT_ITEM_LIMIT = 20;
const CONTEXT_ENTRY_LIMIT = 300;

const PRIORITY_LABEL: Record<string, string> = { low: "低", medium: "中", high: "高" };

export async function buildPersonalSnapshot(actorId: string): Promise<string> {
  const [me, teams, projects, tasks, contexts, timeZone] = await Promise.all([
    db.select({ name: users.name }).from(users).where(eq(users.id, actorId)),
    listMyTeams(actorId),
    listMyProjects(actorId),
    listMyTasks(actorId),
    listMyPersonalContext(actorId),
    resolveUserTimeZone(actorId),
  ]);
  const today = todayIn(timeZone);
  const myName = me[0]?.name ?? "(未知)";

  const head = [
    `今天是 ${today}（我的时区 ${timeZone}，相对日期以此为准推算）`,
    `我是 ${myName}（我的 userId=${actorId}）`,
    `我在 ${teams.length} 个团队、${projects.length} 个项目里，手上 ${tasks.length} 个待办`,
  ].join("\n");

  // 团队段恒保留：teamId 只能取自此处，新建项目要靠它
  const teamBlock =
    "\n\n# 我的团队（teamId 只能取此处的 id）\n" +
    (teams.length > 0
      ? teams.map((t) => `- ${t.name}｜我的角色 ${t.role}｜teamId=${t.id}`).join("\n")
      : "（还没有加入任何团队）");

  // 项目段也近乎恒留：没有它，任何涉及具体项目的工具都无从填 projectId
  const projectBlock =
    "\n\n# 我参与的项目（projectId 只能取此处的 id）\n" +
    (projects.length > 0
      ? projects
          .map(
            (p) =>
              `- ${p.name}｜团队 ${p.teamName}｜${p.status}｜任务 ${p.taskTotal} 个（已完成 ${p.doneCount}）｜projectId=${p.id}`,
          )
          .join("\n")
      : "（还没有参与任何项目）");

  const shownTasks = tasks.slice(0, TASK_LIST_LIMIT);
  const taskBlock =
    shownTasks.length > 0
      ? "\n\n# 我的待办（分配给我的父任务，taskId 取此处的 id）\n" +
        shownTasks
          .map(
            (t) =>
              `- [${t.status}] ${t.title}｜${PRIORITY_LABEL[t.priority] ?? t.priority}｜${t.dueDate ? `截止 ${t.dueDate}` : "无截止"}｜项目 ${t.projectName}｜taskId=${t.id}`,
          )
          .join("\n") +
        (tasks.length > shownTasks.length
          ? `\n（另有 ${tasks.length - shownTasks.length} 个未列出，需要时调 list_tasks 现查）`
          : "")
      : "";

  const shownContexts = contexts.slice(0, CONTEXT_ITEM_LIMIT);
  const contextBlock =
    shownContexts.length > 0
      ? "\n\n# 我的个人上下文（我自己记的；「仅自己」的条目只有我看得到）\n" +
        shownContexts
          .map(
            (c) =>
              `- ${clip(c.content)}${c.visibility === "private" ? "（仅自己）" : "（项目可见）"}`,
          )
          .join("\n") +
        (contexts.length > shownContexts.length
          ? `\n（另有 ${contexts.length - shownContexts.length} 条未列出）`
          : "")
      : "";

  // 逐层降级：先弃待办明细（list_tasks 可兜底），再弃项目明细（list_projects 可兜底），
  // 最后才弃我自己的上下文（没有任何工具能把它们读回来）。身份行与团队段恒保留。
  const full = head + teamBlock + projectBlock + taskBlock + contextBlock;
  if (full.length <= SNAPSHOT_CHAR_LIMIT) return full;

  const withoutTasks = head + teamBlock + projectBlock + contextBlock;
  if (withoutTasks.length <= SNAPSHOT_CHAR_LIMIT) return withoutTasks;

  const withoutProjects = head + teamBlock + contextBlock;
  if (withoutProjects.length <= SNAPSHOT_CHAR_LIMIT) return withoutProjects;

  return head + teamBlock;
}

// 单行呈现：条目里的换行会把「-」列表读成好几条，先折成空格再截断
function clip(text: string): string {
  const oneLine = text.replace(/\s*\n+\s*/g, " ");
  return oneLine.length > CONTEXT_ENTRY_LIMIT
    ? `${oneLine.slice(0, CONTEXT_ENTRY_LIMIT)}…`
    : oneLine;
}
