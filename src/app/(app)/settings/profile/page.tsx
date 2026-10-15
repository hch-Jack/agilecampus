import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { ProfileForm } from "./profile-form";
import { PasswordForm } from "./password-form";

// 修改个人信息：用户名、身份、密码。用户名全站唯一（私信按用户名定位）。
export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [row] = await db
    .select({ name: users.name, identity: users.identity, email: users.email })
    .from(users)
    .where(eq(users.id, session.user.id));

  // 飞书自动建号的账号没有可用密码（随机占位），改密码不必验旧密码
  const feishuOnly = row?.email.endsWith("@feishu.local") ?? false;

  return (
    <main className="mx-auto max-w-2xl space-y-8 py-8">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">修改个人信息</h1>
        <p className="text-sm text-ink-soft">
          用户名全站唯一，用于私信定位；修改后立即生效。
        </p>
      </header>

      <ProfileForm initialName={row?.name ?? ""} initialIdentity={row?.identity ?? null} />

      <PasswordForm feishuOnly={feishuOnly} />
    </main>
  );
}
