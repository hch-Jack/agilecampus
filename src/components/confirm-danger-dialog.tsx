"use client";

import { useEffect } from "react";

/**
 * 危险操作确认弹窗 —— 替换浏览器原生 confirm()。
 * 红色警示风格：alert 三角图标 + 红色渐变头部 + 半透明深色遮罩 + 毛玻璃。
 * 关闭途径：取消按钮 / 点遮罩 / Escape。
 */
export function ConfirmDangerDialog({
  open,
  title,
  children,
  confirmLabel = "确认",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      {/* 遮罩 */}
      <div
        aria-hidden
        onClick={onCancel}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      {/* 弹窗卡片 */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-full max-w-sm overflow-hidden rounded-card border border-line
                   bg-surface shadow-pop"
      >
        {/* 红色警示头部 */}
        <header className="flex items-center gap-3 border-b border-line/60 bg-danger/5 px-5 py-4">
          {/* alert 三角 */}
          <svg
            className="h-6 w-6 flex-shrink-0 text-danger"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
        </header>

        {/* 内容区 */}
        <div className="px-5 py-4 text-sm text-ink-soft leading-relaxed">
          {children}
        </div>

        {/* 按钮区 */}
        <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-ink-soft
                       transition-colors hover:bg-sunken hover:text-ink"
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white
                       bg-danger transition-all
                       hover:bg-danger/85
                       hover:shadow-[0_0_12px_rgba(250,81,81,0.35)]"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}