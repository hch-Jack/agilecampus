import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { ensureLibrary, listLibraryContents } from "@/lib/library/folders";
import { parseLibraryQuery } from "@/lib/library/query";
import { listLibraryOperations } from "@/lib/library/operations";
import { syncPersonalLibrary } from "@/lib/library/sync";
import { LibraryBrowser } from "@/components/library/library-browser";

export const dynamic = "force-dynamic";

function one(v: string | string[] | undefined): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export default async function PersonalLibraryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const sp = await searchParams;
  const folderId = one(sp.folder);
  const query = parseLibraryQuery(sp);

  // 每次打开都强制同步一次：编辑后立刻回到资源库也能看到最新版本；
  // 失败不阻断浏览，页面先展示上次已汇总的内容
  await syncPersonalLibrary(session.user.id, { force: true }).catch(() => {});

  const ref = { kind: "personal" as const, userId: session.user.id };
  const library = await ensureLibrary(ref);
  const [view, operations, timeZone] = await Promise.all([
    listLibraryContents(session.user.id, ref, folderId, query),
    listLibraryOperations(library.id, { limit: 50 }),
    resolveUserTimeZone(session.user.id),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 py-5 sm:py-8">
      <div>
        <h1 className="font-display text-2xl font-semibold text-ink">个人资源库</h1>
        <p className="mt-1 text-sm text-ink-faint">
          汇总我上传的任务附件、私信文件、群文件与助手生成文件；同名文件会自动合并成版本。
        </p>
      </div>
      <LibraryBrowser
        scope="personal"
        libraryName="个人资源库"
        view={view}
        operations={operations}
        timeZone={timeZone}
      />
    </div>
  );
}
