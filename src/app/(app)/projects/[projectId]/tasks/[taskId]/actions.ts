"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { createSubtask, updateTask, deleteTask } from "@/lib/task";
import {
  uploadAttachment,
  deleteAttachment,
  ATTACHMENT_MAX_SIZE,
} from "@/lib/attachment";
import { AppError, ForbiddenError } from "@/lib/errors";

export type FormState = { error: string } | null;

// 子任务/附件的增改删都要同时刷新详情页与看板（看板上的子任务卡片、任务卡片的
// 完成情况/优先级等也会随之变化）
function revalidateTaskPaths(projectId: string, taskId: string) {
  revalidatePath(`/projects/${projectId}/tasks/${taskId}`);
  revalidatePath(`/projects/${projectId}`);
}

const toggleSubtaskSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  subtaskId: z.uuid(),
});

// 勾选/取消勾选子任务完成。语义：取消勾选固定回「待办」，不保留原「进行中」。
export async function toggleSubtaskDoneAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = toggleSubtaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { projectId, taskId, subtaskId } = parsed.data;
  const done = formData.get("done") === "1";

  try {
    await updateTask(session.user.id, subtaskId, { status: done ? "done" : "todo" });
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限修改任务" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidateTaskPaths(projectId, taskId);
  return null;
}

const addSubtaskSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  title: z.string().trim().min(1, "请填写子任务标题"),
  description: z.string().trim().optional(),
  assigneeId: z.uuid().optional(),
  startDate: z.iso.date("日期格式不正确").optional(),
  dueDate: z.iso.date("日期格式不正确").optional(),
  milestoneId: z.uuid().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
});

export async function addSubtaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const raw = Object.fromEntries(formData);
  const parsed = addSubtaskSchema.safeParse({
    ...raw,
    assigneeId: raw.assigneeId || undefined,
    startDate: raw.startDate || undefined,
    dueDate: raw.dueDate || undefined,
    milestoneId: raw.milestoneId || undefined,
    priority: raw.priority || undefined,
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { projectId, taskId, ...input } = parsed.data;

  try {
    await createSubtask(session.user.id, taskId, input);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限创建任务" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidateTaskPaths(projectId, taskId);
  return null;
}

const deleteSubtaskSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  subtaskId: z.uuid(),
});

export async function deleteSubtaskAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = deleteSubtaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { projectId, taskId, subtaskId } = parsed.data;

  try {
    await deleteTask(session.user.id, subtaskId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限删除任务" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidateTaskPaths(projectId, taskId);
  return null;
}

const uploadAttachmentSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
});

export async function uploadAttachmentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = uploadAttachmentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { projectId, taskId } = parsed.data;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "请选择要上传的文件" };
  if (file.size > ATTACHMENT_MAX_SIZE) return { error: "附件不能超过 10MB" };

  try {
    await uploadAttachment(session.user.id, taskId, {
      filename: file.name,
      mimeType: file.type || null,
      size: file.size,
      data: Buffer.from(await file.arrayBuffer()),
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限上传附件" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidateTaskPaths(projectId, taskId);
  return null;
}

const deleteAttachmentSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  attachmentId: z.uuid(),
});

export async function deleteAttachmentAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = deleteAttachmentSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { projectId, taskId, attachmentId } = parsed.data;

  try {
    await deleteAttachment(session.user.id, attachmentId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限删除附件" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidateTaskPaths(projectId, taskId);
  return null;
}

// 删除整个任务（编辑功能自看板迁入详情页后的唯一删除入口）。
// redirect 抛 NEXT_REDIRECT，须置于 try/catch 外；revalidate 先于 redirect。
const deleteTaskSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
});

export async function deleteTaskFromDetailAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = deleteTaskSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "参数无效" };
  const { projectId, taskId } = parsed.data;

  try {
    await deleteTask(session.user.id, taskId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "没有权限删除任务" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidateTaskPaths(projectId, taskId);
  redirect(`/projects/${projectId}`);
}
