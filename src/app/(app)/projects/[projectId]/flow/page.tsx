import { Fragment } from "react";
import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectForUser } from "@/lib/project";
import { listProjectDependencies, listProjectTasks } from "@/lib/task";
import { resolveFlowScope } from "@/lib/flow-scope";
import { DependencyFlow } from "./dependency-flow";
import { FlowTree } from "./flow-tree";

export default async function DependencyFlowPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectId } = await params;
  const sp = await searchParams;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const rawParent = typeof sp.parent === "string" ? sp.parent : null;
  if (rawParent !== null && !z.uuid().safeParse(rawParent).success) notFound();

  const access = await getProjectForUser(session.user.id, projectId);
  if (!access) notFound();

  const [tasks, dependencies] = await Promise.all([
    listProjectTasks(session.user.id, projectId),
    listProjectDependencies(session.user.id, projectId),
  ]);

  // 一次只画一层：顶层任务，或某个父任务的直接子任务
  const scope = resolveFlowScope(
    tasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      parentTaskId: task.parentTaskId,
      sortOrder: task.sortOrder,
    })),
    rawParent,
  );
  if (!scope) notFound();

  const scopeIds = new Set(scope.tasks.map((task) => task.id));
  const scopedDependencies = dependencies.filter(
    (dep) =>
      scopeIds.has(dep.predecessorId) && scopeIds.has(dep.successorId),
  );

  // 历史跨层级边不在任何一层里，单独提示；关系图能看到全量依赖
  const parentOf = new Map(tasks.map((task) => [task.id, task.parentTaskId]));
  const crossLevelCount = dependencies.filter((dep) => {
    const predInProject = parentOf.has(dep.predecessorId);
    const succInProject = parentOf.has(dep.successorId);
    return (
      predInProject &&
      succInProject &&
      dep.predecessorId !== dep.successorId &&
      parentOf.get(dep.predecessorId) !== parentOf.get(dep.successorId)
    );
  }).length;

  const base = `/projects/${projectId}/flow`;

  return (
    <main className="mx-auto max-w-5xl space-y-6 py-8">
      <header className="space-y-1">
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <Link href={`/projects/${projectId}`} className="hover:text-primary">
            ← 返回项目
          </Link>
          <Link href={`/projects/${projectId}/timeline`} className="hover:text-primary">
            时间线 →
          </Link>
          <Link href={`/projects/${projectId}/graph`} className="hover:text-primary">
            关系图 →
          </Link>
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink">
          {access.project.name} · 流程图
        </h1>

        <div
          className="flex flex-wrap items-center gap-1.5 text-xs text-ink-soft"
          aria-label="流程层级"
        >
          <Link
            href={base}
            className={
              scope.parent === null
                ? "font-medium text-ink"
                : "hover:text-primary"
            }
          >
            顶层流程
          </Link>
          {scope.ancestors.map((ancestor, index) => {
            const last = index === scope.ancestors.length - 1;
            return (
              <Fragment key={ancestor.id}>
                <span className="text-ink-faint">/</span>
                {last ? (
                  <span className="max-w-64 truncate font-medium text-ink">
                    {ancestor.title}
                  </span>
                ) : (
                  <Link
                    href={`${base}?parent=${ancestor.id}`}
                    className="max-w-64 truncate hover:text-primary"
                  >
                    {ancestor.title}
                  </Link>
                )}
              </Fragment>
            );
          })}
        </div>

        <p className="text-sm text-ink-soft">
          {scope.parent
            ? `当前展示「${scope.parent.title}」的直接子任务流程（${scope.tasks.length} 个）。`
            : `当前展示顶层任务流程（${scope.tasks.length} 个）。`}
          父任务内部的子流程，点卡片上的「子流程 N」或左侧层级树逐层进入。
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[210px_minmax(0,1fr)] lg:items-start">
        <FlowTree
          projectId={projectId}
          currentParentId={scope.parent?.id ?? null}
          roots={scope.roots}
        />

        <div className="min-w-0 space-y-3">
          <DependencyFlow
            projectId={projectId}
            tasks={scope.tasks}
            dependencies={scopedDependencies}
            childStats={scope.childStats}
          />
          {crossLevelCount > 0 && (
            <p className="text-xs text-ink-faint">
              项目另有 {crossLevelCount} 条历史跨层级依赖，不参与单层流程绘制；可在{" "}
              <Link
                href={`/projects/${projectId}/graph`}
                className="text-primary hover:underline"
              >
                关系图
              </Link>{" "}
              查看。
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
