"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { setMemberPermission } from "@/lib/team-permissions";
import { TEAM_PERMISSIONS } from "@/lib/team-permissions";
import { AppError, ForbiddenError } from "@/lib/errors";

export type ToggleState = { error: string } | null;

const toggleSchema = z.object({
  teamId: z.uuid(),
  userId: z.uuid(),
  permission: z.enum(TEAM_PERMISSIONS),
  value: z.boolean(),
});

/** 勾选/取消一项权限：仅团队管理员；lib 层再校验一次（直调 action 不可绕过） */
export async function setMemberPermissionAction(input: {
  teamId: string;
  userId: string;
  permission: (typeof TEAM_PERMISSIONS)[number];
  value: boolean;
}): Promise<ToggleState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };

  try {
    await setMemberPermission(
      session.user.id,
      parsed.data.teamId,
      parsed.data.userId,
      parsed.data.permission,
      parsed.data.value,
    );
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "仅团队管理员可调整权限" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/teams/${parsed.data.teamId}/permissions`);
  return null;
}
