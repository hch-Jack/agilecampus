import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getTeamForMember } from "@/lib/team";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { ensureLibrary, listLibraryContents } from "@/lib/library/folders";
import { parseLibraryQuery } from "@/lib/library/query";
import { listLibraryOperations } from "@/lib/library/operations";
import { syncTeamLibrary } from "@/lib/library/sync";
import { LibraryBrowser } from "@/components/library/library-browser";
import { BackToProjectButton } from "@/components/library/back-to-project-button";

export const dynamic = "force-dynamic";

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export default async function TeamLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ teamId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const { teamId } = await params;
  if (!z.uuid().safeParse(teamId).success) notFound();
  const team = await getTeamForMember(session.user.id, teamId);
  if (!team) notFound();

  const sp = await searchParams;
  const folderId = one(sp.folder);
  const query = parseLibraryQuery(sp);
  const fromProjectRaw = one(sp.fromProject);
  const fromProject =
    fromProjectRaw && z.uuid().safeParse(fromProjectRaw).success ? fromProjectRaw : null;
  const ref = { kind: "team" as const, teamId };

  await syncTeamLibrary(session.user.id, teamId, { force: true }).catch(() => {});

  const [view, library, timeZone] = await Promise.all([
    listLibraryContents(session.user.id, ref, folderId, query),
    ensureLibrary(ref),
    resolveUserTimeZone(session.user.id),
  ]);
  const operations = await listLibraryOperations(library.id, { limit: 50 });

  return (
    <div className="mx-auto max-w-5xl space-y-4 py-5 sm:py-8">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <a href="/teams" className="text-xs text-ink-faint hover:text-primary">
            ← 我的团队
          </a>
          <BackToProjectButton projectId={fromProject} />
        </div>
        <h1 className="mt-1 font-display text-2xl font-semibold text-ink">
          {team.name} · 资源库
        </h1>
        <p className="mt-1 text-sm text-ink-faint">
          汇总团队全部任务附件与手动同步的群文件；每次更新都会记录操作者与历史版本。
        </p>
      </div>
      <LibraryBrowser
        scope="team"
        teamId={teamId}
        libraryName="团队资源库"
        view={view}
        operations={operations}
        timeZone={timeZone}
      />
    </div>
  );
}
