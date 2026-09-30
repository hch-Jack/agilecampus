"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { createTeam, dissolveTeam, joinTeam } from "@/lib/team";
import { AppError, ForbiddenError } from "@/lib/errors";

export type FormState = { error: string } | null;

const nameSchema = z.string().trim().min(1, "请填写团队名称");
const inviteCodeSchema = z.string().trim().min(1, "请填写邀请码");

export async function createTeamAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = nameSchema.safeParse(formData.get("name") ?? "");
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  await createTeam(session.user.id, parsed.data);
  revalidatePath("/teams");
  return null;
}

export async function joinTeamAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = inviteCodeSchema.safeParse(formData.get("inviteCode") ?? "");
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    await joinTeam(session.user.id, parsed.data);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/teams");
  return null;
}

const dissolveSchema = z.object({ teamId: z.uuid() });

export async function dissolveTeamAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = dissolveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "参数无效" };

  try {
    await dissolveTeam(session.user.id, parsed.data.teamId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "仅团队管理员可解散团队" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  // 只重验证、不跳转：用户本来就站在 /teams 上，这张卡片自己会消失
  revalidatePath("/teams");
  return null;
}
