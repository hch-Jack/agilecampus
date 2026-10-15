"use client";

import { useEffect } from "react";

// 顶栏「设置」菜单弹出的小窗口通用外壳：半透明遮罩 + 居中卡片。
// 打开动画见 project.css 的 .ac-modal-in / .ac-backdrop-in（与全站入场同一曲线）。
// 关闭途径：× 按钮 / 点遮罩 / Escape。
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        aria-hidden
        onClick={onClose}
        className="ac-backdrop-in absolute inset-0 bg-ink/40 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ac-modal-in relative w-full max-w-md overflow-hidden rounded-card border border-line bg-surface shadow-pop"
      >
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-field text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}
