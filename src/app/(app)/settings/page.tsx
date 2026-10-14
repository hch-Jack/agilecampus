import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { DEFAULT_TIMEZONE, formatDateTime, listTimeZones } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { FeishuCard } from "./feishu-card";
import { TimezoneCard } from "./timezone-card";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ feishu?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [row] = await db
    .select({
      feishuName: users.feishuName,
      feishuBoundAt: users.feishuBoundAt,
      timezone: users.timezone,
    })
    .from(users)
    .where(eq(users.id, session.user.id));
  const { feishu } = await searchParams;

  // 飞书绑定时间要按**用户自己的**时区显示（此前是按宿主进程时区手搓的）
  const tz = await resolveUserTimeZone(session.user.id);
  // 选项在服务端生成后整份传给客户端：两边各算一次会因 ICU 版本不同而不一致
  const options = listTimeZones();

  return (
    <main className="mx-auto max-w-2xl space-y-8 py-8">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">AI 设置</h1>
        <p className="text-sm text-ink-soft">
          AI 助手与时间设置。个人访问令牌见
          <Link href="/settings/tokens" className="text-primary underline">
            令牌
          </Link>
          页。
        </p>
      </header>

      <TimezoneCard pref={row?.timezone ?? DEFAULT_TIMEZONE} options={options} />

      <FeishuCard
        boundName={row?.feishuName ?? null}
        boundAtLabel={row?.feishuBoundAt ? formatDateTime(tz, row.feishuBoundAt) : null}
        notice={feishu ?? null}
      />
    </main>
  );
}
