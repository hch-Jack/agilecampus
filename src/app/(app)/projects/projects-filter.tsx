"use client";

import { useEffect, useRef, useState } from "react";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

type TeamOption = { id: string; name: string };

const STATUS_CHIPS = [
  { value: "", label: "全部" },
  { value: "active", label: "进行中" },
  { value: "completed", label: "已结题" },
  { value: "archived", label: "已归档" },
] as const;

/**
 * 所有项目筛选条（方案 A）：状态 chip 单选 + 团队下拉 + 名称搜索，
 * 筛选态写进 URL（可分享、刷新保持）。搜索 300ms 防抖后生效。
 */
export function ProjectsFilter({
  teams,
  total,
  visible,
}: {
  teams: TeamOption[];
  total: number;
  visible: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const status = searchParams.get("status") ?? "";
  const team = searchParams.get("team") ?? "";
  const q = searchParams.get("q") ?? "";
  const dirty = Boolean(status || team || q);

  // 本地输入态 + 防抖同步到 URL；URL 里的 q 变化（前进/后退/清除）时回显
  //（渲染期比较调整状态——React 官方推荐的 effect 替代模式）
  const [draft, setDraft] = useState(q);
  const [prevQ, setPrevQ] = useState(q);
  if (prevQ !== q) {
    setPrevQ(q);
    setDraft(q);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  function patch(key: "status" | "team" | "q", value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function onDraft(value: string) {
    setDraft(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => patch("q", value.trim()), 300);
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_CHIPS.map((c) => (
          <button
            key={c.value || "all"}
            type="button"
            onClick={() => patch("status", c.value)}
            aria-pressed={status === c.value}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              status === c.value
                ? "border-primary bg-primary/10 font-medium text-primary"
                : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {teams.length > 1 && (
        <select
          value={team}
          onChange={(e) => patch("team", e.target.value)}
          aria-label="按团队筛选"
          className="rounded-field border border-line bg-surface px-2 py-1 text-xs text-ink-soft outline-none focus:border-primary"
        >
          <option value="">全部团队</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}

      <input
        type="search"
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        placeholder="搜索项目名…"
        aria-label="搜索项目名"
        className="w-44 rounded-field border border-line bg-surface px-2.5 py-1 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary"
      />

      {dirty && (
        <button
          type="button"
          onClick={() => router.replace(pathname, { scroll: false })}
          className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
        >
          清除
        </button>
      )}
      {dirty && (
        <span className="ml-auto text-xs tabular-nums text-ink-faint">
          {visible}/{total}
        </span>
      )}
    </div>
  );
}
