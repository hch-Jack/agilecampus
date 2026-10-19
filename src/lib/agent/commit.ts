import { z } from "zod";
import { db } from "@/db";
import { createMilestone, createProject, getProjectForUser } from "@/lib/project";
import {
  applyTaskSuccessorDelta,
  createTask,
  listProjectTasks,
  updateTask,
} from "@/lib/task";
import { createPersonalContext } from "@/lib/personal-context";
import { notifyTaskAssigned, notifyTaskCompleted } from "@/lib/notify";
import { AppError, ForbiddenError } from "@/lib/errors";
import {
  personalContextDraftSchema,
  SAVE_CONTEXT_TOOL,
  type CommitToolName,
  type WriteToolName,
} from "./tools";

/**
 * 可选日期：卡片上把日期框**清空**，浏览器交出来的是空串。`z.string().optional()` 收得下它，
 * 底层 lib 的 `if (d && …)` 也当「没给」跳过校验 —— 于是空串一路走到 INSERT，
 * PG 的 date 列当场报 `invalid input syntax for type date: ""`，用户看到的是 500「落库失败」。
 * 在落库这关统一把空串当**没给**（要真清除已有日期，卡片送的是 null，由下面两个 schema 现收）。
 */
const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v === "" ? undefined : v));

const taskDraftSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  startDate: optionalDate,
  dueDate: optionalDate,
  milestoneId: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  startDate: optionalDate,
  endDate: optionalDate,
});

const decomposeSchema = z.object({ tasks: z.array(taskDraftSchema).min(1) });

// PATCH 语义：`""` = 没给（不改），`null` = 清空。空串若直通 date 列会 500，
// 直通文本列则会被当成「改成了空描述」——两者都不是用户点确认时的本意。
const nullablePatch = <T extends z.ZodType>(inner: T) =>
  inner
    .nullable()
    .optional()
    .transform((v) => (v === "" ? undefined : v));

const patchSchema = z.object({
  title: z.string().optional(),
  description: nullablePatch(z.string()),
  status: z.enum(["todo", "doing", "done"]).optional(),
  assigneeId: z.string().optional(),
  startDate: nullablePatch(z.string()),
  // 与上面几处不同，这里 null 是有意义的：把已有截止日**清掉**
  dueDate: nullablePatch(z.string()),
  milestoneId: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  completionNote: nullablePatch(z.string()),
});

const updateTasksSchema = z.object({
  updates: z
    .array(z.object({ taskId: z.string(), updatedAt: z.string(), patch: patchSchema }))
    .min(1),
});

// 依赖调整草案：只取落库要用的三个字段。卡片展示字段（标题、现有后置…）会被 zod
// 自动剥离 —— 别加 `.strict()`，否则草案一转手就报「草案格式无效」。
const linkDraftSchema = z.object({
  predecessorId: z.uuid(),
  add: z.array(z.uuid()).optional(),
  remove: z.array(z.uuid()).optional(),
});

const planSprintSchema = z.object({
  milestoneId: z.string(),
  taskIds: z.array(z.string()).min(1),
  // 排期必须有截止日：空串在这里就拦下（带字段名的报错），别等到 date 列上炸 500
  dueDate: z.string().min(1, "排期要给截止日"),
});

const createMilestoneSchema = z.object({
  title: z.string().min(1),
  targetDate: optionalDate,
});

export type CommitResult = { committed: number; conflicts: string[] };

// 落库：绝不信 Agent 输出——入口重校访问权，每类先施 Zod，再走图二 lib（lib 内建权限/归属校验）
export async function commitDraft(
  actorId: string,
  projectId: string,
  tool: WriteToolName,
  draft: unknown,
): Promise<CommitResult> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  switch (tool) {
    case "create_project": {
      const d = createProjectSchema.parse(draft);
      await createProject(actorId, access.project.teamId, d);
      return { committed: 1, conflicts: [] };
    }
    case "decompose_tasks": {
      const d = decomposeSchema.parse(draft);
      // 批量落库裹事务：中途任一项抛错则整批回滚，杜绝半落库后重试致重复
      const created = await db.transaction(async (tx) => {
        const out: Awaited<ReturnType<typeof createTask>>[] = [];
        for (const t of d.tasks) out.push(await createTask(actorId, projectId, t, { tx }));
        return out;
      });
      // 事务提交后补发通知（tx 路径 createTask 不 fire，由此处统一发）
      for (const t of created) if (t.assigneeId) void notifyTaskAssigned(t);
      return { committed: d.tasks.length, conflicts: [] };
    }
    case "update_tasks": {
      const d = updateTasksSchema.parse(draft);
      const current = await listProjectTasks(actorId, projectId);
      const versionOf = new Map(current.map((r) => [r.id, r.updatedAt.toISOString()]));
      const prevStatus = new Map(current.map((r) => [r.id, r.status]));
      const conflicts: string[] = [];
      // 先剔除版本冲突项，余者裹事务批量应用（整批回滚保证一致）
      const toApply = d.updates.filter((u) => {
        if (versionOf.get(u.taskId) !== u.updatedAt) {
          conflicts.push(u.taskId);
          return false;
        }
        return true;
      });
      const updatedRows = await db.transaction(async (tx) => {
        const out: Awaited<ReturnType<typeof updateTask>>[] = [];
        for (const u of toApply) out.push(await updateTask(actorId, u.taskId, u.patch, { tx }));
        return out;
      });
      // 事务提交后补发完成通知：状态由非 done 转 done 者，知会创建者
      for (const t of updatedRows) {
        if (t.status === "done" && prevStatus.get(t.id) !== "done")
          void notifyTaskCompleted(t, actorId);
      }
      return { committed: updatedRows.length, conflicts };
    }
    case "edit_task_links": {
      const d = linkDraftSchema.parse(draft);
      const r = await applyTaskSuccessorDelta(
        actorId,
        d.predecessorId,
        { add: d.add, remove: d.remove },
        { projectId },
      );
      return { committed: r.added.length + r.removed.length, conflicts: [] };
    }
    case "plan_sprint": {
      const d = planSprintSchema.parse(draft);
      await db.transaction(async (tx) => {
        for (const id of d.taskIds)
          await updateTask(actorId, id, { milestoneId: d.milestoneId, dueDate: d.dueDate }, { tx });
      });
      return { committed: d.taskIds.length, conflicts: [] };
    }
    case "create_milestone": {
      const d = createMilestoneSchema.parse(draft);
      // createMilestone 内部以 role === "admin" 收口，非管理员在此被拒
      await createMilestone(actorId, projectId, d);
      return { committed: 1, conflicts: [] };
    }
  }
}

// 个人上下文：与手填表单同一个口子（lib/personal-context.ts），只是来源记为 agent 而非 manual
export async function commitPersonalContext(
  actorId: string,
  draft: unknown,
): Promise<CommitResult> {
  const d = personalContextDraftSchema.parse(draft);
  const committed = await createPersonalContext(
    actorId,
    d.entries.map((e) => ({ content: e.content, visibility: e.visibility, source: "agent" })),
  );
  return { committed, conflicts: [] };
}

// 与项目版的 createProjectSchema 共用字段定义：个人版只是多一个团队 id，
// 免得两处各写一份、日后加字段时只改一边
const personalCreateProjectSchema = createProjectSchema.extend({ teamId: z.uuid() });

/**
 * 控制台助手（个人 scope）的落库口。
 *
 * 与 `commitDraft` 的分工：**没有「当前项目」**，所以 projectId（或 teamId）由模型填在草案里，
 * 这里负责把它拆出来、逐类重解 zod，然后把剩下的部分交给同一批实现 —— 复用而非重写，
 * 于是「重校权限 + 复算乐观锁 + 事务整批回滚」这些既有约定一个都不少：
 *
 * - 改项目的四类：拆出 `projectId` 后直落 `commitDraft`，它自己会 `getProjectForUser` 重校；
 *   模型拟到用户无权限的项目 → `ForbiddenError`（403），这是预期行为。
 * - `create_project`：teamId 也要从草案里来（没有「当前团队」），拆出来交给 `createProject`，
 *   内部 `requireTeamRole(admin)` 兜底。
 * - `save_personal_context`：userId 恒取发话人（不可能替别人记一笔）。
 */
export async function commitPersonalDraft(
  actorId: string,
  tool: CommitToolName,
  draft: unknown,
): Promise<CommitResult> {
  if (tool === SAVE_CONTEXT_TOOL) return commitPersonalContext(actorId, draft);

  if (tool === "create_project") {
    // teamId 是 uuid 形状，与下面那四类同理：缺了/填成了团队名就说清楚，别甩一句「草案格式无效」
    const raw = (draft ?? {}) as Record<string, unknown>;
    if (typeof raw.teamId !== "string" || !z.uuid().safeParse(raw.teamId).success) {
      throw new AppError("草案里没带团队 id，请让助手重拟一次（说明挂在哪个团队下）");
    }
    const { teamId, ...rest } = personalCreateProjectSchema.parse(raw);
    await createProject(actorId, teamId, rest);
    return { committed: 1, conflicts: [] };
  }

  // 余下四类：草案里带着 projectId（工具 schema 要求），此处拆出来交给项目版实现。
  // 个人模式没有「当前项目」，projectId 只能从草案里来 —— 缺了就说清楚是哪一环缺，
  // 别让笼统的「草案格式无效」把它盖住（update_tasks 曾漏带 projectId，症状正是如此）。
  const { projectId, ...rest } = (draft ?? {}) as Record<string, unknown>;
  if (typeof projectId !== "string" || !z.uuid().safeParse(projectId).success) {
    throw new AppError("草案里没带项目 id，请让助手重拟一次（说明是哪个项目即可）");
  }
  return commitDraft(actorId, projectId, tool as WriteToolName, rest);
}
