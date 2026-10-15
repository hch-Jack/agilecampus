import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { listApiTokens } from "@/lib/api-token";
import { DEFAULT_TIMEZONE, formatDateTime, listTimeZones } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { FeishuCard } from "./feishu-card";
import { TimezoneCard } from "./timezone-card";
import { TokenManager, type TokenRow } from "./token-manager";

// 一页装齐「AI配置」：时区、飞书通知、个人访问令牌。
// 令牌原先是独立的 /settings/tokens，2026-10 按用户要求并到这里（老路由留作跳转）。
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

  // 飞书绑定时间与令牌列表的时间都要按**用户自己的**时区显示
  const tz = await resolveUserTimeZone(session.user.id);
  // 选项在服务端生成后整份传给客户端：两边各算一次会因 ICU 版本不同而不一致
  const options = listTimeZones();

  const tokens: TokenRow[] = (await listApiTokens(session.user.id)).map((t) => ({
    id: t.id,
    name: t.name,
    createdAtLabel: formatDateTime(tz, t.createdAt),
    lastUsedLabel: t.lastUsedAt ? formatDateTime(tz, t.lastUsedAt) : null,
    revoked: t.revokedAt !== null,
  }));

  return (
    <main className="mx-auto max-w-2xl space-y-8 py-8">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold text-ink">AI配置</h1>
        <p className="text-sm text-ink-soft">
          时间显示、飞书通知与个人访问令牌——AI 助手和外部程序都从这一页配。
        </p>
      </header>

      <TimezoneCard pref={row?.timezone ?? DEFAULT_TIMEZONE} options={options} />

      <FeishuCard
        boundName={row?.feishuName ?? null}
        boundAtLabel={row?.feishuBoundAt ? formatDateTime(tz, row.feishuBoundAt) : null}
        notice={feishu ?? null}
      />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold text-ink">个人访问令牌</h2>
          <p className="text-sm text-ink-soft">
            令牌让 Claude Code 等外部程序以你的身份写入——添加任务、填写完成情况、登记资源占用。
            权限等同于你本人，越权操作会被拒绝。泄露即撤销。
          </p>
        </div>

        <TokenManager tokens={tokens} />

        <section className="ac-card space-y-3 p-5">
          <h3 className="font-display text-base font-semibold text-ink">
            如何在 Claude Code 中使用
          </h3>
          <ol className="list-decimal space-y-1.5 pl-5 text-sm text-ink-soft">
            <li>在上方生成令牌，复制明文（只显一次）。</li>
            <li>
              把令牌与本站地址配置给 Claude Code（作为{" "}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">
                AGILECAMPUS_TOKEN
              </code>{" "}
              与
              <code className="ml-1 rounded bg-sunken px-1 py-0.5 font-mono text-xs">
                AGILECAMPUS_URL
              </code>
              ）。
            </li>
            <li>
              即可让 Claude Code 携令牌调用{" "}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono text-xs">/api/agent/*</code>{" "}
              端点，替你写入。详见项目文档
              <code className="ml-1 rounded bg-sunken px-1 py-0.5 font-mono text-xs">
                docs/agent-api.md
              </code>
              。
            </li>
          </ol>
        </section>
      </section>
    </main>
  );
}
