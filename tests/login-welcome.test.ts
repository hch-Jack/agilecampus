import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { createUser } from "@/lib/user";
import { resetDb } from "./helpers";

const signInMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/lib/auth", () => ({ signIn: signInMock }));
vi.mock("next-auth", () => ({
  AuthError: class AuthError extends Error {},
}));

import { loginAction } from "@/app/(auth)/login/actions";

function form(email: string) {
  const fd = new FormData();
  fd.set("email", email);
  fd.set("password", "password123");
  return fd;
}

beforeEach(async () => {
  await resetDb();
  signInMock.mockClear();
});

describe("登录后是否进入欢迎页", () => {
  it("默认进入 /welcome", async () => {
    const user = await createUser({
      email: "welcome-yes@example.com",
      password: "password123",
      name: "welcome_yes",
    });
    expect((await db.select().from(users).where(eq(users.id, user.id)))[0].showWelcome).toBe(
      true,
    );
    await loginAction(null, form("welcome-yes@example.com"));
    expect(signInMock).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/welcome" }),
    );
  });

  it("关闭后直接进入 /dashboard", async () => {
    const user = await createUser({
      email: "welcome-no@example.com",
      password: "password123",
      name: "welcome_no",
    });
    await db.update(users).set({ showWelcome: false }).where(eq(users.id, user.id));
    await loginAction(null, form("WELCOME-NO@example.com"));
    expect(signInMock).toHaveBeenCalledWith(
      "credentials",
      expect.objectContaining({ redirectTo: "/dashboard" }),
    );
  });
});
