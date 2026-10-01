import { eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { tasks as tasksTable } from "@/db/schema";
import { getProjectForUser, listProjectMilestones } from "@/lib/project";
import { getTaskDetail, listSubtasks, listProjectDependencies } from "@/lib/task";
import { listTeamMembers } from "@/lib/team";
import { listTeamLabels } from "@/lib/label";
import { listAttachments } from "@/lib/attachment";
import { listTaskActivities } from "@/lib/activity";
import {
  SubtaskList,
  STATUS_BADGE,
  STATUS_LABEL,
  type SubtaskRowData,
} from "./subtask-list";
import { AttachmentList, type AttachmentRowData } from "./attachment-list";
import { TaskOverview } from "./task-overview";

// 优先级软色 token（与 task-card.tsx 的 PRIORITY_BADGE 同映射，本地复制以免动共享文件）
const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-high-soft text-high",
  medium: "bg-medium-soft text-medium",
  low: "bg-low-soft text-low",
};
const PRIORITY_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

function fmtDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 动态行文案：type → 「做了什么」；field 型带旧值→新值
function activityLine(a: {
  type: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}): string {
  switch (a.type) {
    case "created":
      return "创建了任务";
    case "field":
      return `把${a.field ?? "字段"}从 ${a.oldValue ?? "无"} 改为 ${a.newValue ?? "无"}`;
    case "subtask_added":
      return `添加了子任务「${a.newValue ?? ""}」`;
    case "subtask_done":
      return `完成了子任务「${a.newValue ?? ""}」`;
    case "subtask_reopened":
      return `重启了子任务「${a.newValue ?? ""}」`;
    case "subtask_deleted":
      return `删除了子任务「${a.newValue ?? ""}」`;
    case "attachment_added":
      return `上传了附件「${a.newValue ?? ""}」`;
    case "attachment_deleted":
      return `删除了附件「${a.newValue ?? ""}」`;
    default:
      return a.type;
  }
}

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; taskId: string }>;
}) {
  const { projectId, taskId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");

  // 非法 uuid 一律「不存在」，不泄露格式探测结果
  const idsOk =
    z.uuid().safeParse(projectId).success && z.uuid().safeParse(taskId).success;
  if (!idsOk) notFound();

  const access = await getProjectForUser(session.user.id, projectId);
  if (!access) notFound();
  const canWrite = access.role === "admin" || access.role === "student";

  // catch→null→notFound：不泄露「任务存在但无权限」（沿 getTaskDetail 既有口径）
  const task = await getTaskDetail(session.user.id, taskId).catch(() => null);
  if (!task || task.projectId !== projectId) notFound();

  const [subtasks, dependencies, milestones, activities, attachments] = await Promise.all([
    listSubtasks(session.user.id, taskId),
    listProjectDependencies(session.user.id, projectId),
    listProjectMilestones(session.user.id, projectId),
    listTaskActivities(session.user.id, taskId),
    listAttachments(session.user.id, taskId),
  ]);
  // teacher 只读，无须成员表（仅子任务添加表单用）
  const members = canWrite ? await listTeamMembers(access.project.teamId) : [];

  // 父任务与后置任务的标题，合并一次查询
  const successorIds = dependencies
    .filter((d) => d.predecessorId === taskId)
    .map((d) => d.successorId);
  const titleIds = [...new Set([task.parentTaskId, ...successorIds].filter(Boolean))] as string[];
  const titleMap = titleIds.length
    ? new Map(
        (
          await db
            .select({ id: tasksTable.id, title: tasksTable.title })
            .from(tasksTable)
            .where(inArray(tasksTable.id, titleIds))
        ).map((r) => [r.id, r.title]),
      )
    : new Map<string, string>();

  const milestoneTitle = task.milestoneId
    ? (milestones.find((m) => m.id === task.milestoneId)?.title ?? null)
    : null;

  // 编辑表单数据源（teacher 只读无须）：标签候选按团队，后置任务候选按项目全量任务
  const [allLabels, allTasks] = canWrite
    ? await Promise.all([
        listTeamLabels(session.user.id, access.project.teamId),
        db
          .select({ id: tasksTable.id, title: tasksTable.title })
          .from(tasksTable)
          .where(eq(tasksTable.projectId, projectId))
          .orderBy(tasksTable.sortOrder),
      ])
    : [[], []];
  const successors = successorIds.map((sid) => ({
    id: sid,
    title: titleMap.get(sid) ?? "未知任务",
  }));

  const subtaskRows: SubtaskRowData[] = subtasks.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    priority: s.priority,
    assigneeName: s.assigneeName,
    dueDate: s.dueDate,
  }));
  const attachmentRows: AttachmentRowData[] = attachments.map((a) => ({
    id: a.id,
    filename: a.filename,
    mimeType: a.mimeType,
    size: a.size,
    createdAt: a.createdAt,
    uploaderName: a.uploaderName,
  }));

  return (
    <main className="mx-auto max-w-5xl space-y-6 py-8">
      <div className="space-y-1">
        <Link
          href={`/projects/${projectId}`}
          className="text-sm text-ink-soft hover:text-primary"
        >
          ← 返回项目
        </Link>
        {task.parentTaskId && (
          <p className="text-xs text-ink-faint">
            父任务：
            <Link
              href={`/projects/${projectId}/tasks/${task.parentTaskId}`}
              className="text-primary underline"
            >
              {titleMap.get(task.parentTaskId) ?? "未知任务"}
            </Link>
          </p>
        )}
      </div>

      <header className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-semibold text-ink">{task.title}</h1>
          <span className={`ac-badge ${STATUS_BADGE[task.status] ?? ""}`}>
            {STATUS_LABEL[task.status] ?? task.status}
          </span>
          <span className={`ac-badge ${PRIORITY_BADGE[task.priority] ?? ""}`}>
            {PRIORITY_LABEL[task.priority] ?? task.priority}
          </span>
        </div>
        <p className="text-xs text-ink-faint">
          {task.assigneeName ?? "未分配"}
          {(task.startDate || task.dueDate) &&
            ` · ${task.startDate ?? "…"}→${task.dueDate ?? "…"}`}
          {` · 创建于 ${fmtDateTime(task.createdAt)} · 更新于 ${fmtDateTime(task.updatedAt)}`}
        </p>
      </header>

      <TaskOverview
        projectId={projectId}
        task={{
          id: task.id,
          title: task.title,
          description: task.description,
          completionNote: task.completionNote,
          status: task.status,
          priority: task.priority,
          startDate: task.startDate,
          dueDate: task.dueDate,
          assigneeId: task.assigneeId,
          assigneeName: task.assigneeName,
          milestoneId: task.milestoneId,
          labels: task.labels,
        }}
        canWrite={canWrite}
        milestoneTitle={milestoneTitle}
        successors={successors}
        members={members}
        milestones={milestones.map((m) => ({ id: m.id, name: m.title }))}
        allLabels={allLabels}
        allTasks={allTasks}
      />

      <section className="ac-card p-5">
        <SubtaskList
          projectId={projectId}
          taskId={taskId}
          subtasks={subtaskRows}
          members={members}
          milestones={milestones}
          canWrite={canWrite}
        />
      </section>

      <section className="ac-card p-5">
        <AttachmentList
          projectId={projectId}
          taskId={taskId}
          attachments={attachmentRows}
          canWrite={canWrite}
        />
      </section>

      <section className="ac-card p-5">
        <h2 className="font-display text-lg font-semibold text-ink">动态</h2>
        {activities.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">暂无动态</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {activities.map((a) => (
              <li key={a.id} className="text-sm">
                <span className="font-medium text-ink">{a.actorName}</span>{" "}
                <span className="text-ink-soft">{activityLine(a)}</span>{" "}
                <span className="text-xs text-ink-faint">{fmtDateTime(a.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
