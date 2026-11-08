import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectForUser } from "@/lib/project";
import { listProjectAttachmentCenter } from "@/lib/attachment";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { AttachmentCenter } from "./attachment-center";

/**
 * 项目附件中心：全项目任务的附件一览与上传。
 * 任务分配者（任务创建人）提供的文件与成员上传的文件分组展示。
 */
export default async function AttachmentCenterPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const access = await getProjectForUser(session.user.id, projectId);
  if (!access) notFound();
  const { project, role } = access;

  const [tasks, timeZone] = await Promise.all([
    listProjectAttachmentCenter(session.user.id, projectId),
    resolveUserTimeZone(session.user.id),
  ]);

  // 上传/删除走任务写权限同一口径：管理员或学生
  const canWrite = role === "admin" || role === "student";

  return (
    <main className="mx-auto max-w-5xl space-y-6 py-5 sm:py-8">
      <header className="space-y-1">
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <Link href={`/projects/${projectId}`} className="ac-hit hover:text-primary">
            ← 返回项目
          </Link>
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink">
          {project.name} · 附件中心
        </h1>
        <p className="text-sm text-ink-soft">
          按任务汇总项目里所有文件：任务分配者提供的资料与成员上传的成果都在这里。
        </p>
      </header>

      <AttachmentCenter
        projectId={projectId}
        canWrite={canWrite}
        timeZone={timeZone}
        tasks={tasks}
      />
    </main>
  );
}
