"use client";

import Link from "next/link";
import { formatShortDateTime } from "@/lib/time";
import type { DashboardLibrarySummary } from "../dashboard-types";
import { WidgetEmpty, WidgetShell } from "./shell";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** 工作台「资源库」：个人/团队文件数 + 最近更新，点名字直接进对应资源库 */
export function LibraryWidget({
  summary,
  tz,
}: {
  summary: DashboardLibrarySummary | null;
  tz: string;
}) {
  if (!summary || summary.totalCount === 0) {
    return (
      <WidgetShell title="资源库" href="/library" hrefLabel="进入">
        <WidgetEmpty>
          任务附件、私信文件、群文件与助手生成的文件会自动汇总到资源库。
        </WidgetEmpty>
      </WidgetShell>
    );
  }

  const teamsWithFiles = summary.teams.filter((team) => team.itemCount > 0);
  const shownTeams = teamsWithFiles.slice(0, 3);

  return (
    <WidgetShell title="资源库" href="/library" hrefLabel="进入">
      <div className="flex flex-wrap gap-1.5">
        <Link
          href="/library"
          className="min-w-0 flex-1 rounded-field border border-line bg-surface px-2 py-1.5 transition-colors hover:border-primary/60 hover:bg-primary-soft/30"
        >
          <span className="dw-meta block truncate text-ink-faint">个人资源库</span>
          <span className="font-display text-lg font-semibold tabular-nums text-ink">
            {summary.personalCount}
          </span>
          <span className="dw-meta ml-0.5 text-ink-faint">个文件</span>
        </Link>
        {shownTeams.map((team) => (
          <Link
            key={team.id}
            href={`/teams/${team.id}/library`}
            className="min-w-0 flex-1 rounded-field border border-line bg-surface px-2 py-1.5 transition-colors hover:border-primary/60 hover:bg-primary-soft/30"
            title={team.name}
          >
            <span className="dw-meta block truncate text-ink-faint">{team.name}</span>
            <span className="font-display text-lg font-semibold tabular-nums text-ink">
              {team.itemCount}
            </span>
            <span className="dw-meta ml-0.5 text-ink-faint">个文件</span>
          </Link>
        ))}
        {teamsWithFiles.length > shownTeams.length && (
          <span className="self-center px-1 text-[11px] text-ink-faint">
            +{teamsWithFiles.length - shownTeams.length} 个团队
          </span>
        )}
      </div>

      {summary.recent.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {summary.recent.slice(0, 5).map((file) => (
            <li key={file.id}>
              <Link
                href={
                  file.scope === "personal" || !file.teamId
                    ? "/library"
                    : `/teams/${file.teamId}/library`
                }
                className="dw-item block truncate font-medium text-ink hover:text-primary"
                title={file.filename}
              >
                {file.filename}
              </Link>
              <p className="dw-meta mt-0.5 flex flex-wrap items-center gap-x-1.5 truncate text-ink-faint">
                <span className="truncate">{file.teamName}</span>
                <span aria-hidden>·</span>
                <span>{fmtSize(file.size)}</span>
                <span aria-hidden>·</span>
                <span>{formatShortDateTime(tz, file.updatedAt)}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}
