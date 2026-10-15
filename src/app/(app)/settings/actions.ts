"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth, unstable_update } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import {
  AVATAR_MAX_SIZE,
  detectAvatarMime,
  unbindFeishu,
  updateUserAvatar,
  updateUserPassword,
  updateUserProfile,
  updateUserTimeZone,
} from "@/lib/user";
import { createApiToken, revokeApiToken } from "@/lib/api-token";
import { AppError } from "@/lib/errors";
import { AUTO_TIMEZONE, TZ_COOKIE, TZ_COOKIE_MAX_AGE, isValidTimeZone } from "@/lib/time";

// 小窗表单都带一个隐藏的 from 字段（当前 pathname）：改完后按它重渲染**当前页**，
// 顶栏/页面上的旧数据（昵称、时区、绑定状态）随之刷新，用户无需手动刷新。
// 只认以 / 开头的合法路径，其余落回兜底页，防止脏值喂给 revalidatePath。
function revalidateFrom(formData: FormData, fallback: string) {
  const from = String(formData.get("from") ?? "");
  revalidatePath(from.startsWith("/") && from.length < 1024 ? from : fallback);
}

export async function unbindFeishuAction(formData: FormData) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  await unbindFeishu(session.user.id);
  revalidateFrom(formData, "/settings");
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
  revalidateFrom(formData, "/settings");
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

// ------------------------------------------------------------------ 个人资料
// 顶栏「设置」菜单的「修改信息」小窗：改用户名与身份。校验规则与注册页一致
// （用户名全站唯一、最长 24 位）。

export type ProfileState = { ok: true } | { error: string } | null;

const profileSchema = z.object({
  // 用户名全站唯一（私信按用户名找人），trim 后交由 updateUserProfile 查重
  name: z.string().trim().min(1, "请填写用户名").max(24, "用户名最长 24 位"),
  // 允许空串 = 未设置（存量用户、飞书自动建号的账号没有身份）
  identity: z.enum(["", "teacher", "student"], "身份无效"),
});

export async function updateProfileAction(
  _prev: ProfileState,
  formData: FormData,
): Promise<ProfileState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = profileSchema.safeParse({
    name: formData.get("name") ?? "",
    identity: formData.get("identity") ?? "",
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };

  try {
    const { name } = await updateUserProfile(session.user.id, {
      name: parsed.data.name,
      identity: parsed.data.identity || null,
    });
    // JWT 会话里存的是登录时的用户名，重签一次让顶栏立即显示新名字（见 lib/auth.ts 的 jwt callback）
    await unstable_update({ user: { name } });
    revalidateFrom(formData, "/settings");
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export type PasswordState = { ok: true } | { error: string } | null;

// 改密码：新密码规则与注册一致。是否要验旧密码不能信客户端 ——
// 服务端按账号邮箱判定：飞书自动建号的账号（@feishu.local）是随机占位密码，
// 本人无从得知，直接设新密码；其余账号必须先验当前密码。
export async function updatePasswordAction(
  _prev: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const [row] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, session.user.id));
  const feishuOnly = row?.email.endsWith("@feishu.local") ?? false;

  const currentPassword = String(formData.get("currentPassword") ?? "");
  const newPassword = String(formData.get("newPassword") ?? "");
  if (newPassword.length < 8) return { error: "密码至少 8 位" };
  if (newPassword.length > 64) return { error: "密码最长 64 位" };
  if (!feishuOnly && !currentPassword) return { error: "请填写当前密码" };

  try {
    await updateUserPassword(session.user.id, {
      currentPassword,
      newPassword,
      requireCurrent: !feishuOnly,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export type AvatarState = { ok: true } | { error: string } | null;

// 上传头像：图片校验（类型按魔数、大小 ≤ 2MB）在服务端做，客户端先拦一道省往返。
// 成功后 revalidateFrom 重渲染当前页 —— 顶栏头像与「修改信息」小窗的预览一起换新。
export async function uploadAvatarAction(
  _prev: AvatarState,
  formData: FormData,
): Promise<AvatarState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const entry = formData.get("avatar");
  if (!(entry instanceof File) || entry.size === 0) return { error: "请选择图片" };
  if (entry.size > AVATAR_MAX_SIZE) return { error: "图片不能超过 2MB" };

  const data = Buffer.from(await entry.arrayBuffer());
  const mime = detectAvatarMime(data);
  if (!mime) return { error: "仅支持 PNG、JPEG、WebP 图片" };

  await updateUserAvatar(session.user.id, data, mime);
  revalidateFrom(formData, "/settings");
  return { ok: true };
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
