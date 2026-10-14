import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
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

  return (
    <WelcomeScreen
      username={session.user.name ?? ""}
      timeZone={tz}
      doing={s.doing}
      todo={s.todo}
      risk={s.risk}
    />
  );
}
