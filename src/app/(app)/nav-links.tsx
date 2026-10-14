"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, useState } from "react";

// key 是分区前缀（用于判定当前页），href 是点击跳转目标
const ITEMS = [
  { key: "/dashboard", href: "/dashboard", label: "工作台" },
  { key: "/projects", href: "/projects", label: "所有项目" },
  { key: "/teams", href: "/teams", label: "我的团队" },
  { key: "/settings", href: "/settings", label: "AI 设置" },
] as const;

// 当前路径落在哪个导航分区（含子页）
function activeKey(pathname: string): string {
  for (const it of ITEMS) {
    if (pathname.startsWith(it.key)) return it.key;
  }
  return "";
}

export function NavLinks() {
  const pathname = usePathname();
  const active = activeKey(pathname);
  const itemRefs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);

  // 测量当前激活项的 left/width，驱动胶囊定位；切换时平滑滑过去
  useLayoutEffect(() => {
    const el = itemRefs.current[active];
    if (el) setPill({ left: el.offsetLeft, width: el.offsetWidth });
  }, [active]);

  return (
    <nav className="relative flex items-center gap-1">
      {pill && (
        <span
          aria-hidden
          className="absolute inset-y-0 rounded-field bg-primary-soft transition-all duration-300 ease-out"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {ITEMS.map((item) => {
        const isActive = active === item.key;
        return (
          <Link
            key={item.key}
            href={item.href}
            ref={(el) => {
              itemRefs.current[item.key] = el;
            }}
            className={`relative z-10 rounded-field px-2.5 py-1.5 text-sm transition-colors ${
              isActive
                ? "font-medium text-primary"
                : "text-ink-soft hover:bg-primary-soft hover:text-primary"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
