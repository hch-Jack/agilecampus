import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { userAvatarUrl } from "@/lib/user";
import { getWelcomeStats } from "@/lib/welcome";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { WelcomeScreen } from "./welcome-screen";
import "./welcome.css";

export default async function WelcomePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // 统计与钟面都要用同一个时区，否则「临近逾期」的口径会和页面的「今天」打架
  const tz = await resolveUserTimeZone(session.user.id);
  const s = await getWelcomeStats(session.user.id, tz);

  // 头像：没传过头像就 null，客户端回落成名字首字
  const [row] = await db
    .select({ avatarUpdatedAt: users.avatarUpdatedAt })
    .from(users)
    .where(eq(users.id, session.user.id));
  const avatarUrl = userAvatarUrl(session.user.id, row?.avatarUpdatedAt ?? null);

  return (
    <WelcomeScreen
      username={session.user.name ?? ""}
      avatarUrl={avatarUrl}
      timeZone={tz}
      overdue={s.overdue}
      dueToday={s.dueToday}
      dueThisWeek={s.dueThisWeek}
      doing={s.doing}
      plannedToday={s.plannedToday}
    />
  );
}
