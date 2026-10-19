import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { nullableDatePatch, nullableTextPatch } from "@/lib/agent/validation";
import { getTaskDetail, listTaskLinks, updateTask } from "@/lib/task";

type Ctx = { params: Promise<{ taskId: string }> };

// CC 读取：单任务详情（按 id 直取，含负责人名与完成情况）。
// 依赖两端一并带回：助手要讲清楚「这个任务在流程图里的位置」只读一次就够。
export async function GET(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { taskId: raw } = await ctx.params;
  const parsed = z.uuid().safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "taskId 无效" }, { status: 400 });

  try {
    const [t, links] = await Promise.all([
      getTaskDetail(userId, parsed.data),
      listTaskLinks(userId, parsed.data),
    ]);
    return NextResponse.json({
      ...t,
      predecessors: links.predecessors,
      successors: links.successors,
    });
  } catch (e) {
    return mapAgentError(e, "[GET /api/agent/tasks/:id]");
  }
}

// null 显式清空；"" 视为「没给」（与 nullableDatePatch / nullableTextPatch 一致）。
// 白名单之外的字段（projectId / parentTaskId / createdById / sortOrder）一律不收。
const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: nullableTextPatch,
    assigneeId: z.uuid().nullable().optional(),
    milestoneId: z.uuid().nullable().optional(),
    startDate: nullableDatePatch,
    dueDate: nullableDatePatch,
    status: z.enum(["todo", "doing", "done"]).optional(),
    priority: z.enum(["low", "medium", "high"]).optional(),
    completionNote: nullableTextPatch,
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), {
    message: "至少提供一个待改字段",
  });

// CC 写入：改任务详情。权限（teacher 只读）由 updateTask 兜底。
// 不加乐观锁：与 PATCH /api/agent/projects/:id 口径一致，并发按 last-writer-wins。
export async function PATCH(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const { taskId: raw } = await ctx.params;
  const parsedId = z.uuid().safeParse(raw);
  if (!parsedId.success) return NextResponse.json({ error: "taskId 无效" }, { status: 400 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }

  try {
    const u = await updateTask(userId, parsedId.data, parsed.data);
    return NextResponse.json({
      id: u.id,
      projectId: u.projectId,
      parentTaskId: u.parentTaskId,
      title: u.title,
      description: u.description,
      status: u.status,
      priority: u.priority,
      assigneeId: u.assigneeId,
      milestoneId: u.milestoneId,
      startDate: u.startDate,
      dueDate: u.dueDate,
      completionNote: u.completionNote,
      updatedAt: u.updatedAt,
    });
  } catch (e) {
    return mapAgentError(e, "[PATCH /api/agent/tasks/:id]");
  }
}
