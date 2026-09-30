"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { leaveTeam, removeMember, updateMemberRole } from "@/lib/team";
import { AppError, ForbiddenError } from "@/lib/errors";

export type FormState = { error: string } | null;

// 本页三个动作都是破坏性的、都需要「失败原因显示在控件旁边」，
// 故统一走 useActionState 那一套（与 labels/actions.ts 同范式）。
const ROLE = z.enum(["admin", "teacher", "student"]);

const roleSchema = z.object({
  teamId: z.uuid(),
  userId: z.uuid(),
  role: ROLE,
});

export async function updateRoleAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = roleSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "参数无效" };

  try {
    await updateMemberRole(session.user.id, parsed.data.teamId, parsed.data.userId, parsed.data.role);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "仅团队管理员可改角色" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/teams/${parsed.data.teamId}/members`);
  return null;
}

const memberSchema = z.object({ teamId: z.uuid(), userId: z.uuid() });

export async function removeMemberAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = memberSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "参数无效" };

  try {
    await removeMember(session.user.id, parsed.data.teamId, parsed.data.userId);
  } catch (e) {
    if (e instanceof ForbiddenError) return { error: "仅团队管理员可移除成员" };
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath(`/teams/${parsed.data.teamId}/members`);
  return null;
}

const leaveSchema = z.object({ teamId: z.uuid() });

export async function leaveTeamAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = leaveSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: "参数无效" };

  // 原生 select 未选时提交的是空串，不是 undefined
  const raw = formData.get("successorUserId");
  const successorUserId = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  if (successorUserId && !z.uuid().safeParse(successorUserId).success) {
    return { error: "接任者无效" };
  }

  try {
    await leaveTeam(session.user.id, parsed.data.teamId, {
      successorUserId,
      // 只有页面确实渲染出了「退出并解散」那个确认框时才会带上这个字段
      dissolveIfSole: formData.get("dissolveIfSole") === "1",
    });
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }

  // 顺序要紧：redirect 抛出后下面的代码不再执行，所以 revalidatePath 必须在它前面。
  // 位置也要紧：redirect 靠抛出一个由框架接管的控制流异常工作，
  // **放在 try 里会被上面的 catch 吞掉**，用户会看到「点了没反应」。
  // 退出后成员页对本人只会 404，必须把人送回 /teams。
  revalidatePath("/teams");
  redirect("/teams");
}
