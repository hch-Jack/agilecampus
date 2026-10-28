"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { createTask, updateTask, setTaskSuccessors } from "@/lib/task";
import {
  addTaskPlanSegment,
  clearTaskPlan,
  removeTaskPlanSegment,
} from "@/lib/task-plan";
import { setTaskLabels } from "@/lib/label";
import { createMilestone } from "@/lib/project";
import { AppError, ApprovalRequestedError, ForbiddenError } from "@/lib/errors";
import { ATTACHMENT_MAX_SIZE, uploadAttachment } from "@/lib/attachment";
import { completeProjectDirectly, reopenProject, requestProjectAcceptance } from "@/lib/approval";

export type FormState = { error: string } | null;
// 更新任务专用：成功回 { ok: true }，供编辑弹窗据以自闭
export type UpdateTaskState = { error: string } | { ok: true } | null;

const createTaskSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1, "请填写任务标题"),
  description: z.string().trim().optional(),
  assigneeId: z.uuid().optional(),
  startDate: z.iso.date("日期格式不正确").optional(),
  dueDate: z.iso.date("日期格式不正确").optional(),
  milestoneId: z.uuid().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  /** 完成是否需要审批：页面默认勾选，取消勾选时表单不提交该字段 */
  requireApproval: z.boolean().optional(),
});

export async function createTaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const raw = Object.fromEntries(formData);
  const parsed = createTaskSchema.safeParse({
    ...raw,
    assigneeId: raw.assigneeId || undefined,
    startDate: raw.startDate || undefined,
    dueDate: raw.dueDate || undefined,
    milestoneId: raw.milestoneId || undefined,
    priority: raw.priority || undefined,
    // 复选框只会在勾选时提交 "on"
    requireApproval: raw.requireApproval === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { projectId, ...input } = parsed.data;
  try {
    await createTask(session.user.id, projectId, input);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限创建任务" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${projectId}`);
  return null;
}

const createMilestoneSchema = z.object({
  projectId: z.uuid(),
  title: z.string().trim().min(1, "请填写里程碑标题"),
  targetDate: z.iso.date("日期格式不正确").optional(),
});

export async function createMilestoneAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const raw = Object.fromEntries(formData);
  const parsed = createMilestoneSchema.safeParse({
    ...raw,
    targetDate: raw.targetDate || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    await createMilestone(session.user.id, parsed.data.projectId, {
      title: parsed.data.title,
      targetDate: parsed.data.targetDate,
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "仅团队管理员可创建里程碑" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return null;
}

// 拖拽可改的字段白名单。校验与授权仍全数落在 updateTask
//（指派人须属团队、里程碑须属项目、起止日须落在项目周期内且起≤止），故此处只做形状校验。
const movePatchSchema = z.object({
  status: z.enum(["todo", "doing", "done"]).optional(),
  assigneeId: z.uuid().nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  milestoneId: z.uuid().nullable().optional(),
});

const moveTaskSchema = z.object({
  taskId: z.uuid(),
  projectId: z.uuid(),
  patch: movePatchSchema,
});

export async function moveTaskAction(input: {
  taskId: string;
  projectId: string;
  patch: z.infer<typeof movePatchSchema>;
}): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = moveTaskSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  // 空补丁无事可做，视为非法请求
  if (Object.keys(parsed.data.patch).length === 0) return { error: "参数无效" };

  try {
    await updateTask(session.user.id, parsed.data.taskId, parsed.data.patch);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return null;
}

// 个人任务计划段：日历里给自己排「打算什么时候做这任务」，可多段（区间或单天）。
// 注意这不是改任务官方起止日——任务排期不动，这里只动个人记录。
const planSegmentSchema = z.object({
  taskId: z.uuid(),
  projectId: z.uuid(),
  start: z.iso.date("日期格式不正确"),
  end: z.iso.date("日期格式不正确"),
});

const planClearSchema = z.object({
  taskId: z.uuid(),
  projectId: z.uuid(),
});

export async function addTaskPlanSegmentAction(input: {
  taskId: string;
  projectId: string;
  start: string;
  end: string;
}): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = planSegmentSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await addTaskPlanSegment(
      session.user.id,
      parsed.data.taskId,
      parsed.data.projectId,
      parsed.data.start,
      parsed.data.end,
    );
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard");
  return null;
}

export async function removeTaskPlanSegmentAction(input: {
  taskId: string;
  projectId: string;
  start: string;
  end: string;
}): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = planSegmentSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await removeTaskPlanSegment(
      session.user.id,
      parsed.data.taskId,
      parsed.data.projectId,
      parsed.data.start,
      parsed.data.end,
    );
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard");
  return null;
}

export async function clearTaskPlanAction(input: {
  taskId: string;
  projectId: string;
}): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = planClearSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await clearTaskPlan(session.user.id, parsed.data.taskId, parsed.data.projectId);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard");
  return null;
}

const updateTaskSchema = z.object({
  taskId: z.uuid(),
  projectId: z.uuid(),
  title: z.string().trim().min(1, "标题不可为空"),
  description: z.string().trim().optional(),
  assigneeId: z.uuid().optional(),
  milestoneId: z.uuid().optional(),
  startDate: z.iso.date("日期格式不正确").optional(),
  dueDate: z.iso.date("日期格式不正确").optional(),
  priority: z.enum(["low", "medium", "high"]),
  completionNote: z.string().trim().optional(),
});

export async function updateTaskAction(
  _prev: UpdateTaskState,
  formData: FormData,
): Promise<UpdateTaskState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const raw = Object.fromEntries(formData);
  const parsed = updateTaskSchema.safeParse({
    ...raw,
    assigneeId: raw.assigneeId || undefined,
    milestoneId: raw.milestoneId || undefined,
    startDate: raw.startDate || undefined,
    dueDate: raw.dueDate || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const { taskId, projectId, ...patch } = parsed.data;
  const successorIds = formData
    .getAll("successorIds")
    .map(String)
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  const labelIds = formData
    .getAll("labelIds")
    .map(String)
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  try {
    await updateTask(session.user.id, taskId, {
      title: patch.title,
      description: patch.description ?? null,
      assigneeId: patch.assigneeId ?? null,
      milestoneId: patch.milestoneId ?? null,
      startDate: patch.startDate ?? null,
      dueDate: patch.dueDate ?? null,
      priority: patch.priority,
      completionNote: patch.completionNote ?? null,
    });
    // 历史跨层级后置边不在编辑候选里。若本次提交的同级集合与库中一致，
    // 说明用户没有改动后置任务，跳过整表替换，避免只改标题/日期时误删历史边。
    await setTaskSuccessors(session.user.id, taskId, successorIds, {
      preserveCrossLevelIfSiblingSetUnchanged: true,
    });
    await setTaskLabels(session.user.id, taskId, labelIds);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限修改任务" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${projectId}`);
  return { ok: true };
}

// —— 完成申请提交（完成情况说明 + 附件 + 触发审批）——

const submitCompletionSchema = z.object({
  taskId: z.uuid(),
  projectId: z.uuid(),
  completionNote: z.string().trim().min(1, "请填写完成情况"),
});

export type SubmitCompletionResult =
  | { ok: true; approvalRequested: boolean }
  | { error: string };

/** 附件个数上限：完成资料够用且不拖慢一次提交 */
const COMPLETION_MAX_FILES = 5;

/**
 * 学生提交完成申请：先传附件（此时任务仍在进行中，附件路径合法），
 * 再标 done——学生会被审批流拦截（即申请已受理），管理员直接完成。
 * 拦截型错误在这里是「预期成功」，须转成 ok 返回，别让弹窗当失败展示。
 */
export async function submitCompletionAction(
  formData: FormData,
): Promise<SubmitCompletionResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = submitCompletionSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  const files = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (files.length > COMPLETION_MAX_FILES)
    return { error: `附件最多 ${COMPLETION_MAX_FILES} 个` };
  for (const f of files) {
    if (f.size > ATTACHMENT_MAX_SIZE) return { error: `附件「${f.name}」超过 10MB` };
  }

  try {
    for (const f of files) {
      await uploadAttachment(session.user.id, parsed.data.taskId, {
        filename: f.name,
        mimeType: f.type || null,
        size: f.size,
        data: Buffer.from(await f.arrayBuffer()),
      });
    }
    try {
      await updateTask(session.user.id, parsed.data.taskId, {
        status: "done",
        completionNote: parsed.data.completionNote,
      });
      // 未被拦截 = 操作者是审批者本人（管理员），任务直接完成
      return { ok: true, approvalRequested: false };
    } catch (e) {
      // 学生：完成申请已受理，任务保持未完成状态
      if (e instanceof ApprovalRequestedError) return { ok: true, approvalRequested: true };
      throw e;
    }
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

// —— 项目结题验收 ——

const acceptanceRequestSchema = z.object({
  projectId: z.uuid(),
  note: z.string().trim().max(2000, "结题说明最长 2000 字").optional(),
});

export async function requestProjectAcceptanceAction(input: {
  projectId: string;
  note?: string;
}): Promise<{ ok: true } | { error: string }> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = acceptanceRequestSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    await requestProjectAcceptance(session.user.id, parsed.data.projectId, parsed.data.note);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "只有团队成员可申请结题" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}

const acceptanceCompleteSchema = z.object({ projectId: z.uuid() });

export async function completeProjectAction(input: {
  projectId: string;
}): Promise<{ ok: true } | { error: string }> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = acceptanceCompleteSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };

  try {
    await completeProjectDirectly(session.user.id, parsed.data.projectId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有项目结题验收权限" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}

/** 已结题 → 进行中：任务按结题快照回放（须有结题验收权限） */
export async function reopenProjectAction(input: {
  projectId: string;
}): Promise<{ ok: true } | { error: string }> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = acceptanceCompleteSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };

  try {
    await reopenProject(session.user.id, parsed.data.projectId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有项目结题验收权限" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/projects/${parsed.data.projectId}`);
  return { ok: true };
}
