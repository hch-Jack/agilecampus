import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getWelcomeStats } from "@/lib/welcome";
import { WelcomeScreen } from "./welcome-screen";
import "./welcome.css";

export default async function WelcomePage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const s = await getWelcomeStats(session.user.id);

  return (
    <WelcomeScreen
      username={session.user.name ?? ""}
      doing={s.doing}
      todo={s.todo}
      risk={s.risk}
    />
  );
}
