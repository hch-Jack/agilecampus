"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { signOutAction } from "./actions";

const ITEMS = [
  { href: "/settings/profile", label: "修改个人信息" },
  { href: "/settings#feishu", label: "绑定飞书" },
  { href: "/settings#timezone", label: "时区设置" },
] as const;

// 顶栏右上角「设置」菜单：点击展开一列，外点或 Escape 收起。
// 选中任何一项都先收起再走链接/表单，避免菜单残留。
export function UserMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="ac-btn-ghost"
      >
        设置
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-30 mt-2 w-40 overflow-hidden rounded-field border border-line bg-surface p-1 shadow-lg"
        >
          {ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block rounded px-3 py-2 text-sm text-ink transition-colors hover:bg-sunken hover:text-primary"
            >
              {item.label}
            </Link>
          ))}
          <div className="my-1 h-px bg-line" />
          <form action={signOutAction} onSubmit={() => setOpen(false)}>
            <button
              type="submit"
              role="menuitem"
              className="block w-full rounded px-3 py-2 text-left text-sm text-high transition-colors hover:bg-sunken"
            >
              退出
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
