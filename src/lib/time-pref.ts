/**
 * 每个用户「该按哪个时区看时间」—— 偏好存库，`auto` 时由 cookie 补上浏览器时区。
 *
 * 与 lib/time.ts 的分工：那边是纯换算（客户端也算得了），这边要读库、读 cookie，
 * **只能在请求域里用**。cron、脚本这类没有请求上下文的地方，用 `getTimeZonePref`
 * 拿原始偏好即可（此时 `auto` 会退回默认的中国时间，因为没有「浏览器」可言）。
 */
import { cache } from "react";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { AUTO_TIMEZONE, DEFAULT_TIMEZONE, TZ_COOKIE, resolveTimeZone } from "./time";

/** 原始偏好（可能是 "auto"）。不碰 cookie，故 cron / 脚本里也能用。 */
export async function getTimeZonePref(userId: string): Promise<string> {
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId));
  return row?.timezone ?? DEFAULT_TIMEZONE;
}

/**
 * 浏览器上报的时区。
 *
 * 读 cookie 在 Server Component 里是允许的；但 cron、脚本、测试里没有请求域，
 * `cookies()` 会抛 —— 那种场合就当浏览器不存在（退回默认），而不是把整个请求带崩。
 */
export async function browserTimeZone(): Promise<string | null> {
  try {
    return (await cookies()).get(TZ_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * 最终时区：偏好是 IANA 名就用它，是 `auto` 就用浏览器报上来的那个，
 * 什么都没有就退回默认的中国时间。
 *
 * `cache()` 让同一请求内的布局与页面共用一次查询 —— 每页各查一遍纯属浪费。
 */
export const resolveUserTimeZone = cache(async (userId: string): Promise<string> => {
  const pref = await getTimeZonePref(userId);
  if (pref !== AUTO_TIMEZONE) return resolveTimeZone(pref);
  return resolveTimeZone(pref, await browserTimeZone());
});
