"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  CONTEXT_MAX_LENGTH,
  createPersonalContext,
  deletePersonalContext,
  setPersonalContextVisibility,
} from "@/lib/personal-context";
import { AppError } from "@/lib/errors";

/**
 * 个人上下文的手填入口（工作台那两张卡）。
 *
 * 身份一律取自 session，`userId` 由 lib 按 actorId 落 —— 表单里没有、也不接受身份字段。
 * 内容校验（长度、可见性白名单、零宽字符归一）在 lib/personal-context.ts 收口，
 * 这里只把 AppError 翻译成界面上的一句话。
 */

export type ContextState = { ok: true } | { error: string } | null;

const addSchema = z.object({
  content: z.string().trim().min(1, "请写点什么").max(CONTEXT_MAX_LENGTH, `最多 ${CONTEXT_MAX_LENGTH} 字`),
  visibility: z.enum(["shared", "private"], "可见性无效"),
});

export async function addContextAction(
  _prev: ContextState,
  formData: FormData,
): Promise<ContextState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = addSchema.safeParse({
    content: formData.get("content") ?? "",
    visibility: formData.get("visibility") ?? "shared",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    await createPersonalContext(session.user.id, [
      { content: parsed.data.content, visibility: parsed.data.visibility },
    ]);
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard");
  return { ok: true };
}

// 删一条 / 改可见性：都是「只能动自己的」—— lib 的查询恒带 userId = 发话人，
// 改到他条目的 id 只会得到「上下文不存在」。
export async function deleteContextAction(formData: FormData) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  await deletePersonalContext(session.user.id, z.uuid().parse(formData.get("id")));
  revalidatePath("/dashboard");
}

export async function toggleContextVisibilityAction(formData: FormData) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const id = z.uuid().parse(formData.get("id"));
  const visibility = z.enum(["shared", "private"]).parse(formData.get("visibility"));
  await setPersonalContextVisibility(session.user.id, id, visibility);
  revalidatePath("/dashboard");
}
