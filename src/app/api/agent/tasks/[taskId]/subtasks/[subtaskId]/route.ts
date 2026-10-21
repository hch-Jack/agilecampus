import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateBearer, unauthorized, mapAgentError } from "@/lib/agent-auth";
import { deleteTask, getTaskDetailBundle } from "@/lib/task";

type Ctx = { params: Promise<{ taskId: string; subtaskId: string }> };

const paramsSchema = z.object({ taskId: z.uuid(), subtaskId: z.uuid() });

/**
 * DELETE /api/agent/tasks/{taskId}/subtasks/{subtaskId}
 * 只删子任务；父任务 id 必须与该子任务的实际 parentTaskId 一致。
 * 删除会级联删掉它的下级子任务与依赖，不可恢复。
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const userId = await authenticateBearer(req);
  if (!userId) return unauthorized();

  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: "taskId 或 subtaskId 无效" }, { status: 400 });
  }
  const { taskId, subtaskId } = parsed.data;

  try {
    const detail = await getTaskDetailBundle(userId, subtaskId);
    if (detail.parentTaskId !== taskId) {
      return NextResponse.json({ error: "该任务不是此父任务的子任务" }, { status: 400 });
    }
    await deleteTask(userId, subtaskId);
    return NextResponse.json({ deleted: subtaskId, parentTaskId: taskId });
  } catch (e) {
    return mapAgentError(e, "[DELETE /api/agent/tasks/:id/subtasks/:subtaskId]");
  }
}
