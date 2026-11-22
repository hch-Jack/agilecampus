"use server";

import { AuthError } from "next-auth";
import { eq } from "drizzle-orm";
import { signIn } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";

export type FormState = { error: string } | null;

export async function loginAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    // 用户偏好关闭欢迎页时登录后直接进工作台；账号不存在仍交给 signIn 报错
    const [pref] = email
      ? await db
          .select({ showWelcome: users.showWelcome })
          .from(users)
          .where(eq(users.email, email))
      : [];
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: pref?.showWelcome === false ? "/dashboard" : "/welcome",
    });
    return null;
  } catch (e) {
    if (e instanceof AuthError) return { error: "邮箱或密码不正确" };
    throw e;
  }
}
