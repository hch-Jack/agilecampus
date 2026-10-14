"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { unbindFeishu, updateUserTimeZone } from "@/lib/user";
import { createApiToken, revokeApiToken } from "@/lib/api-token";
import { AppError } from "@/lib/errors";
import { AUTO_TIMEZONE, TZ_COOKIE, TZ_COOKIE_MAX_AGE, isValidTimeZone } from "@/lib/time";

export async function unbindFeishuAction() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await unbindFeishu(session.user.id);
  revalidatePath("/settings");
}

export type TimeZoneState = { error: string } | null;

/**
 * 改时区偏好。
 *
 * 校验放在这里而不是往库里塞完再让渲染层兜底 —— 选项虽由服务端生成，
 * 但表单是用户能改的，不该让一个坏值进库（那会让每一页的 Intl 调用都抛）。
 */
export async function updateTimeZoneAction(
  _prev: TimeZoneState,
  formData: FormData,
): Promise<TimeZoneState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const raw = formData.get("timezone");
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value !== AUTO_TIMEZONE && !isValidTimeZone(value)) {
    return { error: "时区无效，请从列表中选择" };
  }

  await updateUserTimeZone(session.user.id, value);
  revalidatePath("/settings");
  return null;
}

/**
 * 浏览器上报自己的时区，写进 cookie，供「跟随浏览器」在**服务端**解析偏好时读取。
 *
 * 为什么非得走 cookie：页面上的时间绝大多数是服务端渲染的，服务端无从知道浏览器在哪。
 * 值不敏感（就是一个时区名），故非 httpOnly —— 客户端组件要读它来避免每次白跑一趟。
 */
export async function syncBrowserTimeZone(tz: string) {
  const session = await auth();
  if (!session?.user) return; // 未登录就别写
  if (!isValidTimeZone(tz)) return;

  const store = await cookies();
  if (store.get(TZ_COOKIE)?.value === tz) return;
  store.set(TZ_COOKIE, tz, {
    path: "/",
    maxAge: TZ_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
}

// ------------------------------------------------------------------ 访问令牌
// 令牌原来单独一页（/settings/tokens），现已并入本页（用户要求「两个界面合并」）；
// 老路由保留为跳转，见 ./tokens/page.tsx。

export type CreateTokenState =
  | { token: string; name: string }
  | { error: string }
  | null;

const nameSchema = z.string().trim().min(1, "请填写令牌名称").max(64, "名称过长");

// 生成结果：成功回传明文 token（只此一次），失败回传 error。
export async function createTokenAction(
  _prev: CreateTokenState,
  formData: FormData,
): Promise<CreateTokenState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = nameSchema.safeParse(formData.get("name") ?? "");
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const { token, name } = await createApiToken(session.user.id, parsed.data);
    revalidatePath("/settings");
    return { token, name };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export async function revokeTokenAction(formData: FormData) {
  const session = await auth();
  if (!session?.user) throw new AppError("请先登录");

  const id = z.uuid().parse(formData.get("id"));
  await revokeApiToken(session.user.id, id);
  revalidatePath("/settings");
}
