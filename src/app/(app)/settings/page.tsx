import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listApiTokens } from "@/lib/api-token";
import { getAiHistoryLimit } from "@/lib/agent/memory";
import { listMyPersonalContext } from "@/lib/personal-context";
import { formatDateTime } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { AgentHistorySetting } from "@/components/agent-history-setting";
import { PersonalContextCard } from "@/components/personal-context-card";
import { TokenManager, type TokenRow } from "./token-manager";

// 「AI配置」页装两类东西：右侧助手的设置（记忆条数 + 个人上下文）与个人访问令牌。
// 助手设置原先藏在工作台助手卡片右上角的「设置」里，2026-10 助手改成右侧常驻面板后并入本页。
// 时区与飞书绑定在顶栏「设置」菜单的小窗里；令牌原先是独立的 /settings/tokens，
// 也已并入本页（老路由留作跳转）。飞书 OAuth 绑定完成后仍回跳本页（?feishu=...）。
const FEISHU_NOTICE: Record<string, { text: string; ok: boolean }> = {
  bound: { text: "飞书绑定成功。", ok: true },
  state_error: { text: "绑定校验失败，请重试。", ok: false },
  conflict: { text: "该飞书账号已绑定其他用户。", ok: false },
  error: { text: "绑定失败，请稍后重试。", ok: false },
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ feishu?: string }>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { feishu } = await searchParams;
  const notice = feishu ? FEISHU_NOTICE[feishu] : null;

  // 令牌列表的时间按**用户自己的**时区显示
  const tz = await resolveUserTimeZone(session.user.id);

  const [rawTokens, contextItems, historyLimit] = await Promise.all([
    listApiTokens(session.user.id),
    listMyPersonalContext(session.user.id),
    getAiHistoryLimit(session.user.id),
  ]);

  const tokens: TokenRow[] = rawTokens.map((t) => ({
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
          右侧 AI 助手的记忆与个人背景，以及供外部程序使用的个人访问令牌。
        </p>
      </header>

      {notice && (
        <p
          className={`rounded-field border px-3 py-2 text-sm ${
            notice.ok ? "border-done/30 bg-done/10 text-done" : "border-high/30 bg-high/10 text-high"
          }`}
        >
          {notice.text}
        </p>
      )}

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-display text-lg font-semibold text-ink">AI 助手</h2>
          <p className="text-sm text-ink-soft">
            右侧面板的助手每一轮看多少上文，以及它了解你的哪些背景。
          </p>
        </div>

        <div className="ac-card space-y-4 p-5">
          <AgentHistorySetting limit={historyLimit} />
          <div className="border-t border-line pt-3">
            <PersonalContextCard items={contextItems} />
          </div>
        </div>
      </section>

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
