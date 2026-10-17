import { tool } from "ai";
import { z } from "zod";
import { getProjectForUser, listMyProjects, listProjectMilestones } from "@/lib/project";
import { listProjectTasks } from "@/lib/task";
import { listTeamMembers } from "@/lib/team";
import { ForbiddenError } from "@/lib/errors";
import type { TaskStatus } from "@/db/schema";

// 读工具纯函数：权限经底层 lib（listProjectMilestones/listProjectTasks 内部各调 getProjectForUser）
export async function queryProgress(actorId: string, projectId: string) {
  const [ms, ts] = await Promise.all([
    listProjectMilestones(actorId, projectId),
    listProjectTasks(actorId, projectId),
  ]);
  const byStatus: Record<TaskStatus, number> = { todo: 0, doing: 0, done: 0 };
  for (const t of ts) byStatus[t.status]++;
  return {
    taskTotal: ts.length,
    byStatus,
    milestoneTotal: ms.length,
    milestones: ms.map((m) => ({
      title: m.title,
      status: m.status,
      targetDate: m.targetDate,
    })),
  };
}

export async function listTasksFiltered(
  actorId: string,
  projectId: string,
  filters: { status?: TaskStatus; assigneeId?: string; dueBefore?: string },
) {
  let list = await listProjectTasks(actorId, projectId);
  if (filters.status) list = list.filter((t) => t.status === filters.status);
  if (filters.assigneeId) list = list.filter((t) => t.assigneeId === filters.assigneeId);
  if (filters.dueBefore)
    list = list.filter((t) => t.dueDate !== null && t.dueDate <= filters.dueBefore!);
  return list.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    dueDate: t.dueDate,
    assigneeName: t.assigneeName,
  }));
}

// 跨项目概览：裁去 createdAt 等模型用不上的字段，省 token
export async function listMyProjectsBrief(actorId: string) {
  const rows = await listMyProjects(actorId);
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    teamName: p.teamName,
    taskTotal: p.taskTotal,
    doneCount: p.doneCount,
  }));
}

// 里程碑 id 兜底：快照超限降级后模型仍需 milestoneId
export async function listMilestonesBrief(actorId: string, projectId: string) {
  const rows = await listProjectMilestones(actorId, projectId);
  return rows.map((m) => ({
    id: m.id,
    title: m.title,
    status: m.status,
    targetDate: m.targetDate,
  }));
}

// AI SDK 工具装配：绑定 actorId/projectId，execute 委托纯函数
export function buildTools(actorId: string, projectId: string) {
  return {
    query_progress: tool({
      description: "查询该项目进度统计：各状态任务数、里程碑概况。无需参数。",
      inputSchema: z.object({}),
      execute: async () => queryProgress(actorId, projectId),
    }),
    list_tasks: tool({
      description:
        "按状态、负责人、截止日筛选该项目任务，返回含 taskId。改任务前必先用它取回 id。",
      inputSchema: z.object({
        status: z.enum(["todo", "doing", "done"]).optional(),
        assigneeId: z.string().optional().describe("负责人用户 id"),
        dueBefore: z.string().optional().describe("截止日不晚于此日期（YYYY-MM-DD）"),
      }),
      execute: async (filters) => listTasksFiltered(actorId, projectId, filters),
    }),
    list_projects: tool({
      description:
        "列出我参与的全部项目（跨团队）及其任务统计。用户问「我有哪些项目」或需跨项目比较时用。无需参数。",
      inputSchema: z.object({}),
      execute: async () => listMyProjectsBrief(actorId),
    }),
    list_milestones: tool({
      description: "列出该项目全部里程碑，返回含 milestoneId。快照未列出里程碑时用它现查。无需参数。",
      inputSchema: z.object({}),
      execute: async () => listMilestonesBrief(actorId, projectId),
    }),
    create_project: tool({
      description: "拟一个新项目草案（在当前项目所属团队下）。仅产草案，需人工确认后落库。",
      inputSchema: z.object({
        name: z.string(),
        description: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      }),
      execute: async (input) => draftEnvelope("create_project", input),
    }),
    decompose_tasks: tool({
      description: "把目标/需求拆成任务清单草案。仅产草案，需人工确认后落库。",
      inputSchema: z.object({
        tasks: z.array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            assigneeId: z.string().optional(),
            dueDate: z.string().optional(),
            milestoneId: z.string().optional(),
            priority: z.enum(["low", "medium", "high"]).optional(),
          }),
        ),
      }),
      execute: async (input) => draftEnvelope("decompose_tasks", input),
    }),
    update_tasks: tool({
      description: "拟批量任务变更草案（状态/负责人/截止日/里程碑/优先级/标题）。仅产草案，需人工确认。",
      inputSchema: z.object({
        updates: z.array(
          z.object({
            taskId: z.string(),
            patch: z.object({
              title: z.string().optional(),
              status: z.enum(["todo", "doing", "done"]).optional(),
              assigneeId: z.string().optional(),
              dueDate: z.string().optional(),
              milestoneId: z.string().optional(),
              priority: z.enum(["low", "medium", "high"]).optional(),
            }),
          }),
        ),
      }),
      // 为每个 update 填入当前 updatedAt（乐观锁读时版本），供 commit 比对
      execute: async (input) => {
        const rows = await listProjectTasks(actorId, projectId);
        const versionOf = new Map(rows.map((r) => [r.id, r.updatedAt]));
        const updates = input.updates.map((u) => ({
          taskId: u.taskId,
          updatedAt: versionOf.get(u.taskId)?.toISOString() ?? "",
          patch: u.patch,
        }));
        return draftEnvelope("update_tasks", { updates });
      },
    }),
    plan_sprint: tool({
      description: "把选定任务排入某里程碑并批量设截止日。仅产草案，需人工确认。",
      inputSchema: z.object({
        milestoneId: z.string(),
        taskIds: z.array(z.string()),
        dueDate: z.string(),
      }),
      execute: async (input) => draftEnvelope("plan_sprint", input),
    }),
    create_milestone: tool({
      description: "在当前项目下拟一个里程碑草案（阶段节点，如中期答辩）。仅产草案，需人工确认后落库。",
      inputSchema: z.object({
        title: z.string(),
        targetDate: z.string().optional().describe("目标日期 YYYY-MM-DD"),
      }),
      execute: async (input) => draftEnvelope("create_milestone", input),
    }),
  };
}

/**
 * 控制台助手（工作台）的工具集。
 *
 * 与 project 版的差别只有一处，但很关键：**没有「当前项目」**。故凡涉及具体项目的工具都多一个
 * `projectId` 参数，模型只能从快照（我的项目 / 我的待办）或 list_projects 里取；权限仍由底层
 * lib 各自校验（`queryProgress` → `listProjectTasks` → `getProjectForUser`），模型给一个我无权
 * 访问的 projectId 只会拿到「没有权限」，而不是别人的数据。
 *
 * 另外多两件：`list_members`（项目版不给——那里成员段常驻快照，且改名会动到项目助手的行为面）
 * 与 `save_personal_context`（把用户自述的背景记成上下文；同样只产草案）。
 */
export function buildPersonalTools(actorId: string) {
  return {
    list_projects: tool({
      description:
        "列出我参与的全部项目（跨团队）及任务统计，返回含 projectId。要动某个项目前先用它取回 id。无需参数。",
      inputSchema: z.object({}),
      execute: async () => listMyProjectsBrief(actorId),
    }),
    query_progress: tool({
      description: "查询指定项目的进度统计：各状态任务数、里程碑概况。必须给 projectId。",
      inputSchema: z.object({
        projectId: z.string().describe("取自快照「我参与的项目」或 list_projects"),
      }),
      execute: async ({ projectId }) => queryProgress(actorId, projectId),
    }),
    list_tasks: tool({
      description: "按状态、负责人、截止日筛选指定项目的任务，返回含 taskId。改任务前必先用它取回 id。",
      inputSchema: z.object({
        projectId: z.string().describe("取自快照「我参与的项目」或 list_projects"),
        status: z.enum(["todo", "doing", "done"]).optional(),
        assigneeId: z.string().optional().describe("负责人用户 id，取自 list_members"),
        dueBefore: z.string().optional().describe("截止日不晚于此日期（YYYY-MM-DD）"),
      }),
      execute: async ({ projectId, ...filters }) => listTasksFiltered(actorId, projectId, filters),
    }),
    list_milestones: tool({
      description: "列出指定项目的全部里程碑，返回含 milestoneId。",
      inputSchema: z.object({
        projectId: z.string().describe("取自快照「我参与的项目」或 list_projects"),
      }),
      execute: async ({ projectId }) => listMilestonesBrief(actorId, projectId),
    }),
    list_members: tool({
      description:
        "列出指定项目所属团队的成员（姓名/角色/userId）。要指派任务（assigneeId）前必先用它取 id，禁止臆造。",
      inputSchema: z.object({
        projectId: z.string().describe("取自快照「我参与的项目」或 list_projects"),
      }),
      execute: async ({ projectId }) => {
        const access = await getProjectForUser(actorId, projectId);
        if (!access) throw new ForbiddenError();
        const rows = await listTeamMembers(access.project.teamId);
        return rows.map((m) => ({ id: m.id, name: m.name, role: m.role }));
      },
    }),
    create_project: tool({
      description:
        "拟一个新项目草案（挂在我指定的团队下）。必须给 teamId（取自快照「我的团队」）。仅产草案，需人工确认后落库。",
      inputSchema: z.object({
        teamId: z.uuid().describe("取自快照「我的团队」中的 teamId"),
        name: z.string(),
        description: z.string().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
      }),
      execute: async (input) => draftEnvelope("create_project", input),
    }),
    decompose_tasks: tool({
      description: "把目标/需求拆成某项目的任务清单草案。必须给 projectId。仅产草案，需人工确认后落库。",
      inputSchema: z.object({
        projectId: z.uuid().describe("取自快照「我参与的项目」或 list_projects"),
        tasks: z.array(
          z.object({
            title: z.string(),
            description: z.string().optional(),
            assigneeId: z.string().optional(),
            dueDate: z.string().optional(),
            milestoneId: z.string().optional(),
            priority: z.enum(["low", "medium", "high"]).optional(),
          }),
        ),
      }),
      execute: async (input) => draftEnvelope("decompose_tasks", input),
    }),
    update_tasks: tool({
      description: "拟某项目的批量任务变更草案（状态/负责人/截止日/里程碑/优先级/标题）。必须给 projectId。仅产草案。",
      inputSchema: z.object({
        projectId: z.uuid().describe("取自快照「我参与的项目」或 list_projects"),
        updates: z.array(
          z.object({
            taskId: z.string(),
            patch: z.object({
              title: z.string().optional(),
              status: z.enum(["todo", "doing", "done"]).optional(),
              assigneeId: z.string().optional(),
              dueDate: z.string().optional(),
              milestoneId: z.string().optional(),
              priority: z.enum(["low", "medium", "high"]).optional(),
            }),
          }),
        ),
      }),
      // 为每个 update 填入当前 updatedAt（乐观锁读时版本），供 commit 比对；
      // projectId 必须一并进草案 —— 个人模式没有「当前项目」，落库口 commitPersonalDraft
      // 只能从草案里取它来重校权限（漏了就会在确认那一步报「草案格式无效」）。
      execute: async ({ projectId, updates }) => {
        const rows = await listProjectTasks(actorId, projectId);
        const versionOf = new Map(rows.map((r) => [r.id, r.updatedAt]));
        return draftEnvelope("update_tasks", {
          projectId,
          updates: updates.map((u) => ({
            taskId: u.taskId,
            updatedAt: versionOf.get(u.taskId)?.toISOString() ?? "",
            patch: u.patch,
          })),
        });
      },
    }),
    plan_sprint: tool({
      description: "把某项目的一组任务排入某里程碑并统一设截止日。必须给 projectId。仅产草案。",
      inputSchema: z.object({
        projectId: z.uuid().describe("取自快照「我参与的项目」或 list_projects"),
        milestoneId: z.string(),
        taskIds: z.array(z.string()),
        dueDate: z.string(),
      }),
      execute: async (input) => draftEnvelope("plan_sprint", input),
    }),
    create_milestone: tool({
      description: "在某项目下拟一个里程碑草案（阶段节点，如中期答辩）。必须给 projectId。仅产草案。",
      inputSchema: z.object({
        projectId: z.uuid().describe("取自快照「我参与的项目」或 list_projects"),
        title: z.string(),
        targetDate: z.string().optional().describe("目标日期 YYYY-MM-DD"),
      }),
      execute: async (input) => draftEnvelope("create_milestone", input),
    }),
    save_personal_context: tool({
      description:
        "把用户自述的背景、偏好、近况记成「个人上下文」草案（如「我每周三下午有课」）。" +
        "用户只是随口告知、并非要改项目时用它。仅产草案，需用户确认后落库；" +
        "visibility 缺省即「项目可见」（队友可通过项目助手看到），用户说了「别外传/只有我知道」才用 private。",
      inputSchema: personalContextDraftSchema,
      execute: async (input) => draftEnvelope("save_personal_context", input),
    }),
  };
}

export const WRITE_TOOL_NAMES = [
  "create_project",
  "decompose_tasks",
  "update_tasks",
  "plan_sprint",
  "create_milestone",
] as const;

export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];

// 「记住这条」也是一张草案卡，但它不改项目内容，故不并进 WRITE_TOOL_NAMES
// （那个常量是项目助手的写工具面，被 tests/agent-write-tools.test.ts 钉着）。
export const SAVE_CONTEXT_TOOL = "save_personal_context" as const;

/** 需要人工确认才落库的工具全集 —— 两个 scope 的草案都走同一张确认卡 */
export const COMMIT_TOOL_NAMES = [...WRITE_TOOL_NAMES, SAVE_CONTEXT_TOOL] as const;

export type CommitToolName = (typeof COMMIT_TOOL_NAMES)[number];

/**
 * 个人上下文草案：条目数组。`userId` 不在 schema 里 —— 落库时恒取发话人（见 lib/personal-context.ts），
 * 模型就算硬塞一个 userId 也进不来。`visibility` 缺省即 `shared`（项目可见），与手填一致。
 */
export const personalContextDraftSchema = z.object({
  entries: z.array(
    z.object({
      content: z.string(),
      visibility: z.enum(["shared", "private"]).optional(),
    }),
  ),
});

// 草案信封：写工具 execute 的统一返回形态，供 orchestrator 识别提取
export type DraftEnvelope = { __draft: true; tool: CommitToolName; draft: unknown };

function draftEnvelope(tool: CommitToolName, draft: unknown): DraftEnvelope {
  return { __draft: true, tool, draft };
}
