"use client";

import { useEffect, useRef, useState } from "react";
import type { TimeZoneOption } from "@/lib/time";
import { signOutAction } from "./actions";
import { FeishuModal } from "./user-menu/feishu-modal";
import { ProfileModal } from "./user-menu/profile-modal";
import { TimezoneModal } from "./user-menu/timezone-modal";

type ModalKind = "profile" | "feishu" | "timezone";

const MENU_ITEMS: { kind: ModalKind; label: string }[] = [
  { kind: "profile", label: "修改信息" },
  { kind: "feishu", label: "绑定飞书" },
  { kind: "timezone", label: "时区设置" },
];

// 顶栏右上角「设置」菜单：齿轮按钮展开一列，外点或 Escape 收起；
// 前三个功能点开小窗口完成，「退出」直接登出。展开动画见 project.css 的 .ac-pop-in。
export function UserMenu({
  profile,
  feishu,
  timezone,
}: {
  profile: { name: string; identity: "teacher" | "student" | null; feishuOnly: boolean };
  feishu: { boundName: string | null; boundAtLabel: string | null };
  timezone: { pref: string; options: TimeZoneOption[] };
}) {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState<ModalKind | null>(null);
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

  const openModal = (kind: ModalKind) => {
    setOpen(false);
    setModal(kind);
  };

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="设置"
          title="设置"
          onClick={() => setOpen((v) => !v)}
          className="ac-btn-ghost grid h-10 w-10 place-items-center rounded-full"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {open && (
          <div
            role="menu"
            className="ac-pop-in absolute right-0 top-full z-30 mt-2 w-40 overflow-hidden rounded-field border border-line bg-surface p-1 shadow-pop"
          >
            {MENU_ITEMS.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                onClick={() => openModal(item.kind)}
                className="block w-full rounded px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-sunken hover:text-primary"
              >
                {item.label}
              </button>
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

      {modal === "profile" && (
        <ProfileModal
          initialName={profile.name}
          initialIdentity={profile.identity}
          feishuOnly={profile.feishuOnly}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "feishu" && (
        <FeishuModal
          boundName={feishu.boundName}
          boundAtLabel={feishu.boundAtLabel}
          onClose={() => setModal(null)}
        />
      )}
      {modal === "timezone" && (
        <TimezoneModal
          pref={timezone.pref}
          options={timezone.options}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
