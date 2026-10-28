import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getDashboardLayout } from "@/lib/dashboard-layout-store";
import { loadDashboardData } from "@/lib/dashboard-data";
import { DashboardGrid } from "./dashboard-grid";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const hideDone = typeof sp.hideDone === "string" && sp.hideDone === "1";
  const project = typeof sp.project === "string" ? sp.project : null;

  const session = await auth();
  if (!session?.user) redirect("/login");
  const userId = session.user.id;

  // 卡片数据与学生身份的默认布局（审批人变体）都从这里来；布局读取依赖 isApprover。
  const data = await loadDashboardData(userId, { hideDone, project });
  const layout = await getDashboardLayout(userId, { isApprover: data.isApprover });

  return (
    <main className="mx-auto max-w-5xl py-8">
      <DashboardGrid initialLayout={layout} data={data} />
    </main>
  );
}
