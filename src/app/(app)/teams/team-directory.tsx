"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { RoleBadge } from "@/components/badges";
import type { TeamRole } from "@/db/schema";
import type { TeamContentCounts } from "@/lib/team";
import {
  filterAndSortTeams,
  type TeamRoleFilter,
  type TeamSortOrder,
} from "@/lib/team-filter";
import { DissolveTeamForm } from "./dissolve-team-form";
import { ExitTeamForm } from "./exit-team-form";

export interface TeamDirectoryRow {
  id: string;
  name: string;
  inviteCode: string;
  role: TeamRole;
  /** ISO 字符串：服务端 Date 跨 RSC 边界前先序列化，客户端只做排序不需要 Date */
  createdAt: string;
  counts: TeamContentCounts;
}

const ROLE_CHOICES: { id: TeamRoleFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "admin", label: "管理员" },
  { id: "member", label: "成员" },
];

const ORDER_CHOICES: { id: TeamSortOrder; label: string }[] = [
  { id: "newest", label: "最新创建" },
  { id: "oldest", label: "最早创建" },
];

// 与任务筛选条同款的点选 chip
function Chip({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
        on
          ? "border-primary bg-primary-soft text-primary"
          : "border-line bg-surface text-ink-soft hover:border-primary/50 hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

export function TeamDirectory({ teams }: { teams: TeamDirectoryRow[] }) {
  const [query, setQuery] = useState("");
  const [role, setRole] = useState<TeamRoleFilter>("all");
  const [order, setOrder] = useState<TeamSortOrder>("newest");

  const visible = useMemo(
    () => filterAndSortTeams(teams, { query, role, order }),
    [teams, query, role, order],
  );

  const hasFilter = query.trim() !== "" || role !== "all";
  const dirty = hasFilter || order !== "newest";

  function clearFilters() {
    setQuery("");
    setRole("all");
    setOrder("newest");
  }

  if (teams.length === 0) {
    return (
      <div className="ac-card p-8 text-center text-sm text-ink-soft">
        尚未加入任何团队——在上方创建一个，或凭邀请码加入。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 筛选行：名称搜索 + 身份 + 创建时间排序，全部在客户端即时生效 */}
      <div className="space-y-2 rounded-xl border border-line bg-sunken p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索团队名称"
            aria-label="搜索团队名称"
            className="ac-field w-full sm:w-56"
          />
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink-soft">角色</span>
            {ROLE_CHOICES.map((c) => (
              <Chip key={c.id} on={role === c.id} onClick={() => setRole(c.id)}>
                {c.label}
              </Chip>
            ))}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink-soft">创建时间</span>
            {ORDER_CHOICES.map((c) => (
              <Chip key={c.id} on={order === c.id} onClick={() => setOrder(c.id)}>
                {c.label}
              </Chip>
            ))}
          </span>
          <span className="text-xs text-ink-faint">
            {hasFilter ? `显示 ${visible.length} / ${teams.length} 个` : `共 ${teams.length} 个`}
          </span>
          {dirty && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-ink-faint hover:text-high"
            >
              清除筛选
            </button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          没有符合条件的团队。
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((t) => (
            <li key={t.id} className="ac-card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-display text-base font-semibold text-ink">
                      {t.name}
                    </span>
                    <RoleBadge role={t.role} />
                  </div>
                  <p className="mt-1 text-xs text-ink-faint">
                    邀请码 <span className="font-mono text-ink-soft">{t.inviteCode}</span>
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                <Link href={`/teams/${t.id}/projects`} className="ac-btn-ghost">
                  项目
                </Link>
                <Link href={`/teams/${t.id}/library`} className="ac-btn-ghost">
                  资源库
                </Link>
                <Link href={`/teams/${t.id}/resources`} className="ac-btn-ghost">
                  资源占用
                </Link>
                <Link href={`/teams/${t.id}/members`} className="ac-btn-ghost">
                  成员管理
                </Link>
                <Link href={`/teams/${t.id}/labels`} className="ac-btn-ghost">
                  标签
                </Link>
                <Link href={`/teams/${t.id}/permissions`} className="ac-btn-ghost">
                  权限管理
                </Link>
              </div>
              {/* 解散/退出按钮统一放在卡片右下角，成员页内不再出现 */}
              {t.role === "admin" ? (
                <DissolveTeamForm teamId={t.id} teamName={t.name} counts={t.counts} />
              ) : (
                <ExitTeamForm teamId={t.id} teamName={t.name} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
