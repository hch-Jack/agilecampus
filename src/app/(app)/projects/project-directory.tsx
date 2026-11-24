"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { CardSparkles } from "@/components/card-sparkles";
import type { ProjectStatus } from "@/db/schema";
import {
  filterAndSortProjects,
  type ProjectSortOrder,
  type ProjectStatusFilter,
} from "@/lib/project-filter";

export interface ProjectDirectoryRow {
  id: string;
  name: string;
  status: ProjectStatus;
  teamId: string;
  teamName: string;
  /** ISO 字符串：服务端 Date 跨 RSC 边界前先序列化，客户端只做排序不需要 Date */
  createdAt: string;
  taskTotal: number;
  doneCount: number;
}

// 与团队项目页同款的状态徽章
const STATUS_BADGE: Record<ProjectStatus, string> = {
  active: "bg-doing/10 text-doing",
  completed: "bg-done/10 text-done",
  archived: "bg-sunken text-ink-soft",
};
const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: "进行中",
  completed: "已结题",
  archived: "已归档",
};

const STATUS_CHOICES: { id: ProjectStatusFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "active", label: STATUS_LABEL.active },
  { id: "completed", label: STATUS_LABEL.completed },
  { id: "archived", label: STATUS_LABEL.archived },
];

const ORDER_CHOICES: { id: ProjectSortOrder; label: string }[] = [
  { id: "newest", label: "最新创建" },
  { id: "oldest", label: "最早创建" },
];

// 进度色相：0% 橙 → 100% 天蓝（色相 30 → 200），返回深/浅两端用于渐变
function progressColors(pct: number): { deep: string; light: string } {
  const hue = 30 + (pct / 100) * 170;
  return {
    deep: `hsl(${hue.toFixed(0)}, 82%, 44%)`,
    light: `hsl(${hue.toFixed(0)}, 55%, 80%)`,
  };
}

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

export function ProjectDirectory({ projects }: { projects: ProjectDirectoryRow[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<ProjectStatusFilter>("all");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [order, setOrder] = useState<ProjectSortOrder>("newest");

  // 团队选项从现有项目推导：只列「我的项目实际所属」的团队；
  // 按团队名排序，同名团队仍以 id 区分。
  const teamChoices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const p of projects) seen.set(p.teamId, p.teamName);
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [projects]);

  const visible = useMemo(
    () => filterAndSortProjects(projects, { query, status, teamId, order }),
    [projects, query, status, teamId, order],
  );

  const hasFilter = query.trim() !== "" || status !== "all" || teamId !== null;
  const dirty = hasFilter || order !== "newest";

  function clearFilters() {
    setQuery("");
    setStatus("all");
    setTeamId(null);
    setOrder("newest");
  }

  if (projects.length === 0) {
    return (
      <div className="ac-card p-8 text-center text-sm text-ink-soft">
        暂无项目——先在团队中创建。
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 筛选行：名称搜索 + 状态 + 创建时间排序，全部在客户端即时生效 */}
      <div className="space-y-2 rounded-xl border border-line bg-sunken p-3 text-sm">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索项目名称"
            aria-label="搜索项目名称"
            className="ac-field w-full sm:w-56"
          />
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink-soft">状态</span>
            {STATUS_CHOICES.map((c) => (
              <Chip key={c.id} on={status === c.id} onClick={() => setStatus(c.id)}>
                {c.label}
              </Chip>
            ))}
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-ink-soft">团队</span>
            <Chip on={teamId === null} onClick={() => setTeamId(null)}>
              全部
            </Chip>
            {teamChoices.map((t) => (
              <Chip key={t.id} on={teamId === t.id} onClick={() => setTeamId(t.id)}>
                {t.name}
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
            {hasFilter ? `显示 ${visible.length} / ${projects.length} 个` : `共 ${projects.length} 个`}
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
          没有符合条件的项目。
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {visible.map((p) => {
            const pct = p.taskTotal > 0 ? (p.doneCount / p.taskTotal) * 100 : 0;
            const R = 20;
            const C = 2 * Math.PI * R;
            const { deep, light } = progressColors(pct);
            // 保留一位小数显示，整数时去掉多余的 .0
            const pctText = (Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, "");
            return (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="ac-card ac-card-link group relative block p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate font-display text-base font-semibold text-ink group-hover:text-primary">
                      {p.name}
                    </span>
                    <span className={`ac-badge ${STATUS_BADGE[p.status]}`}>
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-faint">{p.teamName}</p>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-ink-soft">
                      <div>任务进度</div>
                      <div className="mt-0.5 tabular-nums text-ink-faint">
                        {p.doneCount}/{p.taskTotal}
                      </div>
                    </div>
                    <div className="relative h-14 w-14 shrink-0">
                      <svg viewBox="0 0 48 48" className="h-full w-full">
                        <defs>
                          <linearGradient id={`ring-${p.id}`} x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0%" stopColor={deep} />
                            <stop offset="100%" stopColor={light} />
                          </linearGradient>
                        </defs>
                        <g transform="rotate(-90 24 24)">
                          <circle
                            cx="24" cy="24" r="20" fill="none"
                            stroke="currentColor" strokeWidth="5"
                            className="text-line"
                          />
                          <circle
                            cx="24" cy="24" r="20" fill="none"
                            stroke={`url(#ring-${p.id})`} strokeWidth="5" strokeLinecap="round"
                            strokeDasharray={C}
                            strokeDashoffset={C * (1 - pct / 100)}
                          />
                        </g>
                      </svg>
                      <span className="absolute inset-0 grid place-items-center text-xs font-semibold text-ink">
                        {pctText}%
                      </span>
                    </div>
                  </div>
                  <CardSparkles />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
