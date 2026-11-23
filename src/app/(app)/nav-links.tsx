"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderIcon } from "@/components/file-type-icon";
import { activeNavKey, NAV_ITEMS } from "./nav-items";

type LibraryTeam = { id: string; name: string };

export function NavLinks({
  className = "",
  libraryTeams,
}: {
  className?: string;
  libraryTeams: LibraryTeam[];
}) {
  const pathname = usePathname();
  const active = activeNavKey(pathname);
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const [pill, setPill] = useState<{ left: number; width: number } | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const [lastPath, setLastPath] = useState(pathname);
  const libraryRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // 换页就收起下拉（含浏览器前进/后退）
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setLibraryOpen(false);
  }

  // 测量当前激活项的 left/width，驱动胶囊定位；切换时平滑滑过去
  useLayoutEffect(() => {
    const el = itemRefs.current[active];
    const nav = navRef.current;
    if (!el || !nav) return;
    // 用相对 nav 的矩形：资源库按钮包在相对定位的 wrapper 里，offsetLeft 不可靠
    const itemRect = el.getBoundingClientRect();
    const navRect = nav.getBoundingClientRect();
    setPill({ left: itemRect.left - navRect.left, width: itemRect.width });
  }, [active]);

  // 点空白处 / Esc / 滚动 / 缩放窗口时收起资源库下拉
  useEffect(() => {
    if (!libraryOpen) return;
    function onPointer(e: PointerEvent) {
      const target = e.target as Node;
      if (
        libraryRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return;
      }
      setLibraryOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setLibraryOpen(false);
    }
    function onViewportChange() {
      setLibraryOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onViewportChange, true);
    window.addEventListener("resize", onViewportChange);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onViewportChange, true);
      window.removeEventListener("resize", onViewportChange);
    };
  }, [libraryOpen]);

  const itemClass = (isActive: boolean) =>
    `relative z-10 rounded-field px-2.5 py-1.5 text-sm transition-colors ${
      isActive
        ? "font-medium text-primary"
        : "text-ink-soft hover:bg-primary-soft hover:text-primary"
    }`;

  return (
    <nav ref={navRef} className={`relative flex items-center gap-1 ${className}`}>
      {pill && (
        <span
          aria-hidden
          className="absolute inset-y-0 rounded-field bg-primary-soft transition-all duration-300 ease-out"
          style={{ left: pill.left, width: pill.width }}
        />
      )}
      {NAV_ITEMS.map((item) => {
        const isActive = active === item.key;

        if (item.key === "/library") {
          return (
            <div
              key={item.key}
              ref={(el) => {
                libraryRef.current = el;
              }}
              className="relative"
            >
              <button
                ref={(el) => {
                  itemRefs.current[item.key] = el;
                }}
                type="button"
                aria-haspopup="menu"
                aria-expanded={libraryOpen}
                onClick={() => {
                  if (libraryOpen) {
                    setLibraryOpen(false);
                    return;
                  }
                  const el = itemRefs.current[item.key];
                  if (el) {
                    const rect = el.getBoundingClientRect();
                    setMenuPos({
                      top: rect.bottom + 4,
                      left: rect.left,
                      width: Math.max(rect.width, 240),
                    });
                  }
                  setLibraryOpen(true);
                }}
                className={`${itemClass(isActive)} inline-flex items-center gap-0.5`}
              >
                {item.label}
                <span aria-hidden className="text-[10px]">
                  ▾
                </span>
              </button>

              {/* 挂到 body：顶栏自身有 backdrop-blur，嵌在里面的下拉采样不到页面内容，
                  模糊会失效；portal 出去后才能和顶栏一样看到毛玻璃效果 */}
              {libraryOpen &&
                menuPos &&
                createPortal(
                  <div
                    ref={menuRef}
                    role="menu"
                    aria-label="选择资源库"
                    className="ac-pop-in fixed z-50 rounded-card border border-line bg-surface/85 p-1 shadow-pop backdrop-blur"
                    style={{
                      top: menuPos.top,
                      left: menuPos.left,
                      width: menuPos.width,
                      transformOrigin: "top left",
                    }}
                  >
                    <Link
                      href="/library"
                      role="menuitem"
                      onClick={() => setLibraryOpen(false)}
                      className="flex min-h-9 items-center rounded-field px-2.5 text-sm text-ink-soft hover:bg-primary-soft hover:text-primary"
                    >
                      个人资源库
                    </Link>
                    <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium text-ink-faint">
                      团队资源库
                    </p>
                    {libraryTeams.length === 0 ? (
                      <p className="px-2.5 py-1.5 text-xs text-ink-faint">
                        还没有加入团队
                      </p>
                    ) : (
                      libraryTeams.map((team) => (
                        <Link
                          key={team.id}
                          href={`/teams/${team.id}/library`}
                          role="menuitem"
                          onClick={() => setLibraryOpen(false)}
                          className="flex min-h-9 items-center gap-2 rounded-field px-2.5 text-sm text-ink-soft hover:bg-primary-soft hover:text-primary"
                          title={team.name}
                        >
                          <FolderIcon className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 truncate">{team.name}</span>
                        </Link>
                      ))
                    )}
                  </div>,
                  document.body,
                )}
            </div>
          );
        }

        return (
          <Link
            key={item.key}
            href={item.href}
            ref={(el) => {
              itemRefs.current[item.key] = el;
            }}
            className={itemClass(isActive)}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
