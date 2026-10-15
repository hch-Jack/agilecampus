import { randomBytes } from "node:crypto";
import { db } from "@/db";
import { users, type UserIdentity } from "@/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "./password";
import { exchangeOAuthCode } from "./feishu";
import { AppError, isUniqueViolation } from "./errors";
import { AUTO_TIMEZONE, DEFAULT_TIMEZONE, isValidTimeZone } from "./time";

export async function createUser(input: {
  email: string;
  password: string;
  name: string;
  // 可空：存量调用方（飞书自动建号等）不传即存 NULL，加入团队时按 student 处理
  identity?: UserIdentity | null;
}) {
  const email = input.email.toLowerCase();
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (existing) throw new AppError("该邮箱已被注册");

  // 用户名全局唯一：私信按用户名精准定位到人。查重不区分大小写，DB 唯一索引兜底精确匹配。
  const name = input.name.trim();
  const [nameTaken] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.name}) = lower(${name})`);
  if (nameTaken) throw new AppError("该用户名已被使用，请换一个");

  const passwordHash = await hashPassword(input.password);
  try {
    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        name,
        identity: input.identity ?? null,
      })
      .returning({ id: users.id, email: users.email, name: users.name });
    return user;
  } catch (e) {
    // 查重与插入之间的并发窗口：另一请求已抢先注册，由 DB 唯一约束兜底
    if (isUniqueViolation(e)) throw new AppError(uniqueViolationMessage(e));
    throw e;
  }
}

// 唯一键冲突转译：按冲突的约束区分是邮箱还是用户名撞车。
// postgres.js 的 PostgresError 不暴露 constraint 字段，约束名只在 message 文本里；
// drizzle 又在外面包一层 DrizzleQueryError（顶层 message 是查询语句，原始错误在 cause 上），故两层 message 都要看。
function uniqueViolationMessage(e: unknown): string {
  const w = e as { message?: string; cause?: { message?: string } };
  const msg = `${w.message ?? ""} ${w.cause?.message ?? ""}`;
  if (msg.includes("users_name_unique")) return "该用户名已被使用，请换一个";
  return "该邮箱已被注册";
}

// 绑定当前用户的飞书身份。open_id 唯一——已被他人绑定则转译友好错误。
export async function bindFeishu(userId: string, input: { openId: string; name: string }) {
  try {
    await db
      .update(users)
      .set({ feishuOpenId: input.openId, feishuName: input.name, feishuBoundAt: sql`now()` })
      .where(eq(users.id, userId));
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("该飞书账号已绑定其他用户");
    throw e;
  }
}

// 改用户名与身份（个人资料页）。用户名全站唯一（私信按用户名定位），
// 查重排除自己、不区分大小写，DB 唯一索引兜底并发窗口。
export async function updateUserProfile(
  userId: string,
  input: { name: string; identity: UserIdentity | null },
) {
  const name = input.name.trim();
  const [nameTaken] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(sql`lower(${users.name}) = lower(${name})`, ne(users.id, userId)));
  if (nameTaken) throw new AppError("该用户名已被使用，请换一个");

  try {
    const [user] = await db
      .update(users)
      .set({ name, identity: input.identity })
      .where(eq(users.id, userId))
      .returning({ id: users.id, name: users.name });
    return user;
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError("该用户名已被使用，请换一个");
    throw e;
  }
}

// 改密码：先验旧密码再设新密码。飞书自动建号的账号是随机占位密码、本人无从得知，
// 故传 requireCurrent=false 直接设置（调用方按「飞书专用账号」判定）。
export async function updateUserPassword(
  userId: string,
  input: { currentPassword: string; newPassword: string; requireCurrent: boolean },
) {
  if (input.requireCurrent) {
    const [user] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId));
    if (!user || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw new AppError("当前密码不正确");
    }
  }
  const passwordHash = await hashPassword(input.newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
}

export async function unbindFeishu(userId: string) {
  await db
    .update(users)
    .set({ feishuOpenId: null, feishuName: null, feishuBoundAt: null })
    .where(eq(users.id, userId));
}

/**
 * 改时区偏好。入参已由调用方（settings/actions.ts）用 `isValidTimeZone` / `AUTO_TIMEZONE` 校验过；
 * 这里再兜一道底 —— 非法值一律落回默认的中国时间，绝不让一个坏值进库后把每页渲染都炸掉。
 */
export async function updateUserTimeZone(userId: string, timezone: string) {
  const value = timezone === AUTO_TIMEZONE || isValidTimeZone(timezone) ? timezone : DEFAULT_TIMEZONE;
  await db.update(users).set({ timezone: value }).where(eq(users.id, userId));
  return value;
}

// ------------------------------------------------------------------ 头像
// 头像直存 users 表 bytea（与私信附件同构），经 /api/avatars/[userId] 流出。
// 全站统一从这里拼 URL：?v= 带上传时刻（毫秒），换头像即换地址、旧缓存自然失效。
export const AVATAR_MAX_SIZE = 2 * 1024 * 1024;

export function userAvatarUrl(userId: string, avatarUpdatedAt: Date | null): string | null {
  return avatarUpdatedAt ? `/api/avatars/${userId}?v=${avatarUpdatedAt.getTime()}` : null;
}

// 魔数嗅探：不信客户端报上来的 file.type，只收 PNG / JPEG / WebP。
export function detectAvatarMime(data: Uint8Array): string | null {
  if (
    data.length >= 8 &&
    data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
    data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// 覆盖式更新：换头像即覆盖旧图，旧版本 URL（?v= 旧值）从此 404，不落垃圾行。
// 尺寸与格式由调用方（settings/actions.ts）先验过，这里只负责落库。
export async function updateUserAvatar(userId: string, data: Buffer, mime: string) {
  await db
    .update(users)
    .set({ avatarData: data, avatarMime: mime, avatarUpdatedAt: sql`now()` })
    .where(eq(users.id, userId));
}

// 飞书登录的账号解析：已绑 openId → 返回原账号；未绑 → 自动建号（占位 email + 不可用 hash，禁邮箱登录）。
export async function findOrCreateByFeishu(input: { openId: string; name: string }) {
  const [existing] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.feishuOpenId, input.openId));
  if (existing) return existing;

  const email = `${input.openId.toLowerCase()}@feishu.local`;
  const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
  try {
    const [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash,
        name: input.name,
        feishuOpenId: input.openId,
        feishuName: input.name,
        feishuBoundAt: sql`now()`,
      })
      .returning({ id: users.id, email: users.email, name: users.name });
    return user;
  } catch (e) {
    if (isUniqueViolation(e)) {
      // 并发：另一请求已为同一 openId 抢先建号 → 回查复用
      const [u] = await db
        .select({ id: users.id, email: users.email, name: users.name })
        .from(users)
        .where(eq(users.feishuOpenId, input.openId));
      if (u) return u;
      // 撞了别人的用户名（全站唯一）：追加 openId 尾号区分，站内仍可被搜到
      const [user] = await db
        .insert(users)
        .values({
          email,
          passwordHash,
          name: `${input.name}-${input.openId.slice(-4)}`,
          feishuOpenId: input.openId,
          feishuName: input.name,
          feishuBoundAt: sql`now()`,
        })
        .returning({ id: users.id, email: users.email, name: users.name });
      return user;
    }
    throw e;
  }
}

// 飞书登录归一入口：一次性 code → openId → 找/建账号。OAuth 与 JSSDK 两路共用。
export async function loginWithFeishuCode(code: string) {
  const { openId, name } = await exchangeOAuthCode(code);
  return findOrCreateByFeishu({ openId, name });
}
