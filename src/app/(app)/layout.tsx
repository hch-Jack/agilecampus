import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { IdentityBadge } from "@/components/badges";
import { AssistantShell, AssistantToggle } from "@/components/assistant-shell";
import { getAssistantPanelData } from "@/lib/agent/conversation";
import { ASSISTANT_CONVERSATION_COOKIE } from "@/lib/agent/assistant-panel-shared";
import { AUTO_TIMEZONE, DEFAULT_TIMEZONE, formatDateTime, listTimeZones } from "@/lib/time";
import { getTimeZonePref, resolveUserTimeZone } from "@/lib/time-pref";
import { userAvatarUrl } from "@/lib/user";
import { ProjTheme } from "./proj-theme";
import { NavLinks } from "./nav-links";
import { TzSync } from "./tz-sync";
import { UserMenu } from "./user-menu";
import "./project.css";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // 一次取齐顶栏需要的一切：身份徽章、「设置」菜单三个小窗的初始值
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      identity: users.identity,
      feishuName: users.feishuName,
      feishuBoundAt: users.feishuBoundAt,
      timezone: users.timezone,
      avatarUpdatedAt: users.avatarUpdatedAt,
      tutorialSeenAt: users.tutorialSeenAt,
    })
    .from(users)
    .where(eq(users.id, session.user.id));
  const identity = row?.identity ?? null;
  const avatarUrl = userAvatarUrl(session.user.id, row?.avatarUpdatedAt ?? null);

  // 时区偏好为「跟随浏览器」时，才需要客户端把本机时区报到 cookie 里。
  // 助手面板的数据一次性取好（只读，不建会话）：会话列表 + 上次看的那条 + 其最近 200 条消息。
  // cookie 只是「上次看的是哪条」的提示，lib 会校验归属；面板在每个页面都常驻，别让它无限膨胀。
  const cookieStore = await cookies();
  const preferredConversationId =
    cookieStore.get(ASSISTANT_CONVERSATION_COOKIE)?.value ?? null;

  const [tz, timeZonePref, assistant] = await Promise.all([
    resolveUserTimeZone(session.user.id),
    getTimeZonePref(session.user.id),
    getAssistantPanelData(session.user.id, preferredConversationId),
  ]);

  return (
    <ProjTheme>
      <AssistantShell
        initialConversations={assistant.conversations}
        initialActiveId={assistant.activeId}
        initialMessages={assistant.messages}
      >
        <TzSync auto={timeZonePref === AUTO_TIMEZONE} />
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface/85 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-6">
            {/* 徽标回欢迎页（整屏的时钟页），不是工作台 */}
            <Link href="/welcome" className="flex items-center gap-2">
              <span
                aria-hidden
                className="grid h-7 w-7 place-items-center rounded-md bg-primary font-display text-sm font-bold text-white shadow-sm"
              >
                A
              </span>
              <span className="font-display text-lg font-semibold text-ink">AgileCampus</span>
            </Link>
            <NavLinks />
          </div>
          <div className="flex items-center gap-3">
            <AssistantToggle />
            <IdentityBadge identity={identity} className="hidden sm:inline-flex" />
            {avatarUrl ? (
              // 有头像显图片；proj-avatar 类只在宇宙主题里有样式（描边光晕），图片沿用同一圈。
              // 头像是 <2MB 的本地小图且按版本号寻址长缓存，next/image 优化器帮不上忙。
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt=""
                className="proj-avatar hidden h-10 w-10 rounded-full border border-line object-cover sm:block"
              />
            ) : (
              <span
                aria-hidden
                className="proj-avatar hidden h-10 w-10 place-items-center rounded-full text-base font-bold text-white sm:grid"
              >
                {session.user.name?.charAt(0) || "?"}
              </span>
            )}
            <span className="hidden text-sm text-ink-soft sm:inline">{session.user.name}</span>
            <UserMenu
              // 教程从未看过（NULL）→ 顶栏首次加载自动弹出一次
              tutorial={{ autoOpen: row?.tutorialSeenAt == null }}
              profile={{
                name: row?.name ?? "",
                identity: row?.identity ?? null,
                // 飞书自动建号的账号是随机占位密码、本人无从得知，改密码免验旧密码
                feishuOnly: row?.email.endsWith("@feishu.local") ?? false,
                avatarUrl,
              }}
              feishu={{
                boundName: row?.feishuName ?? null,
                boundAtLabel: row?.feishuBoundAt ? formatDateTime(tz, row.feishuBoundAt) : null,
              }}
              timezone={{
                pref: row?.timezone ?? DEFAULT_TIMEZONE,
                // 选项在服务端生成后整份传给客户端：两边各算一次会因 ICU 版本不同而不一致
                options: listTimeZones(),
              }}
            />
          </div>
        </header>
        <div className="mx-auto max-w-5xl p-6">{children}</div>
      </AssistantShell>
    </ProjTheme>
  );
}
