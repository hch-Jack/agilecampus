import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMyProjects } from "@/lib/project";
import { ProjectDirectory, type ProjectDirectoryRow } from "./project-directory";

export default async function AllProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const projects = await listMyProjects(session.user.id);

  // 页面只把数据交给客户端筛选组件；Date 先转 ISO，跨 RSC 边界更稳妥
  const rows: ProjectDirectoryRow[] = projects.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    teamId: p.teamId,
    teamName: p.teamName,
    createdAt: p.createdAt.toISOString(),
    taskTotal: p.taskTotal,
    doneCount: p.doneCount,
  }));

  return (
    <main className="mx-auto max-w-5xl space-y-8 py-5 sm:py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">所有项目</h1>
      <ProjectDirectory projects={rows} />
    </main>
  );
}
