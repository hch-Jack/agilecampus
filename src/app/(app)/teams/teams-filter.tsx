"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * 我的团队筛选条：chip 点选即筛，筛选态写进 URL（可分享、刷新保持）。
 * created=1 只看我创建的；admin=1 我是管理员；member=1 我是普通成员
 * （非管理员）——三者可叠加，覆盖我加入的全部可能。
 */
export function TeamsFilter({ total, visible }: { total: number; visible: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function push(key: "created" | "admin" | "member") {
    const next = new URLSearchParams(searchParams.toString());
    if (next.get(key)) next.delete(key);
    else next.set(key, "1");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const created = searchParams.get("created") === "1";
  const admin = searchParams.get("admin") === "1";
  const member = searchParams.get("member") === "1";
  const dirty = created || admin || member;

  function clear() {
    router.replace(pathname, { scroll: false });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm">
      <Chip active={created} onClick={() => push("created")} label="我创建的" />
      <Chip active={admin} onClick={() => push("admin")} label="我是管理员" />
      <Chip active={member} onClick={() => push("member")} label="我是成员" />
      {dirty && (
        <button
          type="button"
          onClick={clear}
          className="ml-1 text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
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

function Chip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-primary bg-primary/10 font-medium text-primary"
          : "border-line bg-surface text-ink-soft hover:border-line-strong hover:text-ink"
      }`}
    >
      {label}
    </button>
  );
}
