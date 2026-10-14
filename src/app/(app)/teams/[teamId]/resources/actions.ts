"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { createResourceUsage, endResourceUsage } from "@/lib/resource";
import { AppError } from "@/lib/errors";
import { zonedWallClockToInstant } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";

export type FormState = { error: string } | null;

const createSchema = z.object({
  teamId: z.uuid(),
  resourceName: z.string().trim().min(1, "请填写资源名称"),
  purpose: z.string().trim().optional(),
  startTime: z.string().min(1, "请选择开始时间"),
  endTime: z.string().optional(),
});

export async function createResourceAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  // datetime-local 提交的是**没有时区**的墙面时间，`new Date(字符串)` 会按服务端进程的
  // 时区去解析 —— 那是容器时区，不是用户的。必须明确这是用户所选时区里的那个读数。
  const tz = await resolveUserTimeZone(session.user.id);
  let start: Date;
  let end: Date | undefined;
  try {
    start = zonedWallClockToInstant(tz, parsed.data.startTime);
    end = parsed.data.endTime ? zonedWallClockToInstant(tz, parsed.data.endTime) : undefined;
  } catch {
    return { error: "时间无效" };
  }

  try {
    await createResourceUsage(session.user.id, parsed.data.teamId, {
      resourceName: parsed.data.resourceName,
      purpose: parsed.data.purpose,
      startTime: start,
      endTime: end,
    });
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/teams/${parsed.data.teamId}/resources`);
  return null;
}

const endSchema = z.object({ teamId: z.uuid(), usageId: z.uuid() });

export async function endResourceAction(formData: FormData) {
  const session = await auth();
  if (!session?.user) throw new AppError("请先登录");

  const parsed = endSchema.parse(Object.fromEntries(formData));
  await endResourceUsage(session.user.id, parsed.usageId);
  revalidatePath(`/teams/${parsed.teamId}/resources`);
}
