"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { activeNavKey, NAV_ITEMS } from "./nav-items";

// 手机端导航：顶栏放不下四个分区（390px 下会竖排折字），收进左上角的菜单里。
// 只在 <640px 出现（sm:hidden）；桌面端仍用 nav-links 的胶囊。
export function MobileNav() {
  const pathname = usePathname();
  const active = activeNavKey(pathname);
  const [open, setOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);

  // 换页就收起（含浏览器前进/后退）。用渲染期调整 state，避免 effect 里同步 setState
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }

  // 打开时按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="sm:hidden">
      <button
        type="button"
        aria-label={open ? "关闭导航菜单" : "打开导航菜单"}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        onClick={() => setOpen((v) => !v)}
        className="grid h-10 w-10 place-items-center rounded-field text-ink-soft transition-colors hover:bg-primary-soft hover:text-primary"
      >
        {open ? (
          <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        ) : (
          <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M4 7h16M4 12h16M4 17h16" />
          </svg>
        )}
      </button>
      {/* 挂到 body 上：顶栏的 backdrop-blur 会给 fixed 后代造出新的包含块，
          留在顶栏里的话遮罩只有顶栏那么高，点下方空白也关不掉 */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-40">
            {/* 点空白处收起 */}
            <button
              type="button"
              aria-label="关闭导航菜单"
              tabIndex={-1}
              onClick={() => setOpen(false)}
              className="absolute inset-0 bg-black/35"
            />
            <nav
              id="mobile-nav-panel"
              className="mobile-nav-sheet absolute inset-x-3 top-[calc(3.5rem+env(safe-area-inset-top))] rounded-card border border-line bg-surface p-2 shadow-lg"
            >
              {NAV_ITEMS.map((item) => {
                const isActive = active === item.key;
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    onClick={() => setOpen(false)}
                    aria-current={isActive ? "page" : undefined}
                    className={`flex min-h-11 items-center justify-between rounded-field px-3 text-[0.9375rem] transition-colors ${
                      isActive
                        ? "bg-primary-soft font-medium text-primary"
                        : "text-ink-soft hover:bg-primary-soft hover:text-primary"
                    }`}
                  >
                    {item.label}
                    {isActive && (
                      <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
                    )}
                  </Link>
                );
              })}
            </nav>
          </div>,
          document.body,
        )}
    </div>
  );
}
