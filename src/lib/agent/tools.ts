import { tool } from "ai";
import { z } from "zod";
import { getProjectForUser, listMyProjects, listProjectMilestones } from "@/lib/project";
import {
  getTaskDetailBundle,
  listProjectDependenciesDetailed,
  listProjectTasks,
} from "@/lib/task";
import { listTeamMembers } from "@/lib/team";
import { AppError, ForbiddenError } from "@/lib/errors";
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
    startDate: t.startDate,
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

/**
 * `edit_task_links` 的草案。除增量参数外还带上「现在长什么样」：
 * 确认卡片要把现有后置列出来供核对，并按 `parentTaskId` 滤出同级候选 ——
 * 这些信息模型没义务复述，且让它复述只会多一处可编造的地方。
 *
 * 顺带在**拟草案时**就校验任务归属：否则用户点确认才炸，还得自己猜是哪一步不对。
 * projectId 恒写进草案（个人 scope 落库口靠它重校权限；项目 scope 用页面那个，值相同）。
 */
async function editLinksDraft(
  actorId: string,
  projectId: string,
  input: { predecessorId: string; add?: string[]; remove?: string[] },
) {
  if (!input.add?.length && !input.remove?.length)
    throw new AppError("请至少给出要新增或移除的后置任务");
  const detail = await getTaskDetailBundle(actorId, input.predecessorId, { projectId });
  return draftEnvelope("edit_task_links", {
    projectId,
    predecessorId: input.predecessorId,
    predecessorTitle: detail.title,
    predecessorParentTaskId: detail.parentTaskId,
    currentSuccessors: detail.successors.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      parentTaskId: s.parentTaskId,
    })),
    add: [...new Set(input.add ?? [])],
    remove: [...new Set(input.remove ?? [])],
  });
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
    get_task_detail: tool({
      description:
        "读取单个任务的完整详情：描述、起止日、状态/优先级、负责人、里程碑、父任务、标签、子任务、前置/后置任务。" +
        "改任务详情或调整依赖前先读它——只需要 taskId。",
      inputSchema: z.object({
        taskId: z.string().describe("取自 list_tasks 或快照"),
      }),
      // 项目 scope 额外校验任务属于当前项目：模型拿错 id 时直接报错，别把别处任务带出来
      execute: async ({ taskId }) => getTaskDetailBundle(actorId, taskId, { projectId }),
    }),
    list_dependencies: tool({
      description:
        "列出该项目全部依赖边（前置任务 → 后置任务），带两端标题/状态/是否跨层级。" +
        "用户问关系图、流程图、谁挡着谁、任务先后顺序时用。无需参数。",
      inputSchema: z.object({}),
      execute: async () => listProjectDependenciesDetailed(actorId, projectId),
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
            startDate: z.string().optional().describe("起始日 YYYY-MM-DD"),
            dueDate: z.string().optional().describe("截止日 YYYY-MM-DD"),
            milestoneId: z.string().optional(),
            priority: z.enum(["low", "medium", "high"]).optional(),
          }),
        ),
      }),
      execute: async (input) => draftEnvelope("decompose_tasks", input),
    }),
    update_tasks: tool({
      description:
        "拟批量任务变更草案（标题/描述/状态/负责人/起止日/里程碑/优先级/完成说明）。仅产草案，需人工确认。",
      inputSchema: z.object({
        updates: z.array(
          z.object({
            taskId: z.string(),
            patch: z.object({
              title: z.string().optional(),
              description: z.string().nullable().optional().describe("新描述；传 null 表示清空"),
              status: z.enum(["todo", "doing", "done"]).optional(),
              assigneeId: z.string().optional(),
              startDate: z.string().nullable().optional().describe("起始日 YYYY-MM-DD；传 null 表示清空"),
              dueDate: z.string().optional().describe("截止日 YYYY-MM-DD"),
              milestoneId: z.string().optional(),
              priority: z.enum(["low", "medium", "high"]).optional(),
              completionNote: z.string().nullable().optional().describe("完成说明；传 null 表示清空"),
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
    edit_task_links: tool({
      description:
        "拟一份「后置任务」调整草案（增量：add 新增、remove 移除，其余旧边不动）。" +
        "predecessorId 是前置任务；后置任务须与它同级（同一个父任务）。" +
        "要调整依赖前先 get_task_detail 看清现有前后置。仅产草案，需人工确认。",
      inputSchema: z.object({
        predecessorId: z.string().describe("前置任务 id（要给它加/删后置）"),
        add: z.array(z.string()).optional().describe("要新增的后置任务 id（须与前置任务同级）"),
        remove: z.array(z.string()).optional().describe("要移除的后置任务 id（只限同级）"),
      }),
      execute: async (input) => editLinksDraft(actorId, projectId, input),
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
    get_task_detail: tool({
      description:
        "读取单个任务的完整详情：描述、起止日、状态/优先级、负责人、里程碑、父任务、标签、子任务、前置/后置任务。" +
        "taskId 在全局唯一，只需给 taskId；想调依赖时要从中取项目的前后置 id。改详情或依赖前先读它。",
      inputSchema: z.object({
        taskId: z.string().describe("取自 list_tasks 或快照"),
      }),
      // 个人 scope 无「当前项目」：详情自带 projectId，权限由 lib 按任务实际所属项目校验
      execute: async ({ taskId }) => getTaskDetailBundle(actorId, taskId),
    }),
    list_dependencies: tool({
      description:
        "列出指定项目全部依赖边（前置任务 → 后置任务），带两端标题/状态/是否跨层级。" +
        "用户问关系图、流程图、谁挡着谁、任务先后顺序时用。必须给 projectId。",
      inputSchema: z.object({
        projectId: z.string().describe("取自快照「我参与的项目」或 list_projects"),
      }),
      execute: async ({ projectId }) => listProjectDependenciesDetailed(actorId, projectId),
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
            startDate: z.string().optional().describe("起始日 YYYY-MM-DD"),
            dueDate: z.string().optional().describe("截止日 YYYY-MM-DD"),
            milestoneId: z.string().optional(),
            priority: z.enum(["low", "medium", "high"]).optional(),
          }),
        ),
      }),
      execute: async (input) => draftEnvelope("decompose_tasks", input),
    }),
    update_tasks: tool({
      description:
        "拟某项目的批量任务变更草案（标题/描述/状态/负责人/起止日/里程碑/优先级/完成说明）。必须给 projectId。仅产草案。",
      inputSchema: z.object({
        projectId: z.uuid().describe("取自快照「我参与的项目」或 list_projects"),
        updates: z.array(
          z.object({
            taskId: z.string(),
            patch: z.object({
              title: z.string().optional(),
              description: z.string().nullable().optional().describe("新描述；传 null 表示清空"),
              status: z.enum(["todo", "doing", "done"]).optional(),
              assigneeId: z.string().optional(),
              startDate: z.string().nullable().optional().describe("起始日 YYYY-MM-DD；传 null 表示清空"),
              dueDate: z.string().optional().describe("截止日 YYYY-MM-DD"),
              milestoneId: z.string().optional(),
              priority: z.enum(["low", "medium", "high"]).optional(),
              completionNote: z.string().nullable().optional().describe("完成说明；传 null 表示清空"),
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
    edit_task_links: tool({
      description:
        "拟一份「后置任务」调整草案（增量：add 新增、remove 移除，其余旧边不动）。必须给 projectId。" +
        "predecessorId 是前置任务；后置任务须与它同级（同一个父任务）。" +
        "要调整依赖前先 get_task_detail 看清现有前后置。仅产草案，需人工确认。",
      inputSchema: z.object({
        projectId: z.uuid().describe("取自快照「我参与的项目」或 list_projects"),
        predecessorId: z.string().describe("前置任务 id（要给它加/删后置）"),
        add: z.array(z.string()).optional().describe("要新增的后置任务 id（须与前置任务同级）"),
        remove: z.array(z.string()).optional().describe("要移除的后置任务 id（只限同级）"),
      }),
      // projectId 一并进草案；editLinksDraft 顺带校验前置任务确属该项目
      execute: async ({ projectId, ...input }) => editLinksDraft(actorId, projectId, input),
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
  "edit_task_links",
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
