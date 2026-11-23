import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listProjectContributors } from "@/lib/contributors";
import { IdentityBadge, RoleBadge } from "@/components/badges";

const fmtDay = (day: string) => day.replace(/-/g, "/");

/** 小进度条（纯 CSS）：完成率/按时率用；null 显示 — */
function RateBar({ value, label }: { value: number | null; label: string }) {
  if (value == null) return <span className="text-ink-faint">—</span>;
  const pct = Math.round(value * 100);
  return (
    <span className="inline-flex items-center gap-1.5" title={`${label} ${pct}%`}>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-sunken">
        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular-nums text-ink-soft">{pct}%</span>
    </span>
  );
}

/**
 * 项目贡献度表：成员负责任务的程度（含子任务完成），全员可见。
 * 各指标独立呈现，不合成总分——任务有轻重，加权是人为拍脑袋。
 */
export default async function ContributorsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const { rows, projectName } = await listProjectContributors(session.user.id, projectId);

  return (
    <main className="mx-auto max-w-4xl space-y-5 py-5 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-semibold text-ink">贡献度</h1>
          <p className="mt-0.5 truncate text-sm text-ink-faint">{projectName}</p>
        </div>
        <Link href={`/projects/${projectId}`} className="ac-btn-ghost whitespace-nowrap">
          ← 返回项目
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          还没有成员参与任务——创建并分配任务后，这里会出现各成员的贡献数据。
        </div>
      ) : (
        <div className="ac-card overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-ink-soft">
                <th className="px-4 py-3 font-medium">成员</th>
                <th className="px-3 py-3 text-center font-medium">在办</th>
                <th className="px-3 py-3 text-center font-medium">完成</th>
                <th className="px-3 py-3 font-medium">完成率</th>
                <th className="px-3 py-3 font-medium">按时完成率</th>
                <th className="px-3 py-3 text-center font-medium">创建</th>
                <th className="px-3 py-3 text-center font-medium">动态</th>
                <th className="px-4 py-3 font-medium">最近活动</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.userId} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-2.5">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-ink">{r.name}</span>
                      <IdentityBadge identity={r.identity} role={r.role} />
                      {r.role === "admin" && <RoleBadge role="admin" />}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-ink-soft">{r.active}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums font-medium text-ink">{r.done}</td>
                  <td className="px-3 py-2.5">
                    <RateBar value={r.completionRate} label="完成率" />
                  </td>
                  <td className="px-3 py-2.5">
                    <RateBar value={r.onTimeRate} label="按时完成率" />
                  </td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-ink-soft">{r.created}</td>
                  <td className="px-3 py-2.5 text-center tabular-nums text-ink-soft">{r.activityCount}</td>
                  <td className="px-4 py-2.5 tabular-nums text-ink-faint">
                    {r.lastActiveDay ? fmtDay(r.lastActiveDay) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs leading-relaxed text-ink-faint">
        口径：含子任务（子任务的完成计入其负责人）。「在办」= 当前负责人未完成的任务；「完成」按完成时点归属（任务转交后历史完成仍归原完成者）；
        「按时完成率」只统计有截止日且能判定完成时点的任务；「动态」= 改动任务/增删子任务/传附件等过程参与次数。
        各指标独立呈现、不合成总分——任务有轻重，请综合判断。
      </p>
    </main>
  );
}
