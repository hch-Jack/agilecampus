import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth, signOut } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { IdentityBadge } from "@/components/badges";
import { ProjTheme } from "./proj-theme";
import { NavLinks } from "./nav-links";
import "./project.css";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // 读取当前用户身份（teacher / student）；老用户与飞书用户为 NULL，不显示标签
  const [identityRow] = await db
    .select({ identity: users.identity })
    .from(users)
    .where(eq(users.id, session.user.id));
  const identity = identityRow?.identity ?? null;

  return (
    <ProjTheme>
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-surface/85 px-6 py-3 backdrop-blur">
          <div className="flex items-center gap-6">
            <Link href="/projects" className="flex items-center gap-2">
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
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/login" });
            }}
            className="flex items-center gap-3"
          >
            <IdentityBadge identity={identity} className="hidden sm:inline-flex" />
            <span
              aria-hidden
              className="proj-avatar hidden h-10 w-10 place-items-center rounded-full text-base font-bold text-white sm:grid"
            >
              {session.user.name?.charAt(0) || "?"}
            </span>
            <span className="hidden text-sm text-ink-soft sm:inline">{session.user.name}</span>
            <button className="ac-btn-ghost">退出</button>
          </form>
        </header>
        <div className="mx-auto max-w-5xl p-6">{children}</div>
      </div>
    </ProjTheme>
  );
}
