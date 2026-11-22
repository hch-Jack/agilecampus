"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * 危险操作确认弹窗 —— 替换浏览器原生 confirm()。
 * 红色警示风格：alert 三角图标 + 红色渐变头部 + 半透明深色遮罩 + 毛玻璃。
 * 关闭途径：取消按钮 / 点遮罩 / Escape。
 *
 * 用 Portal 挂到 document.body：侧栏/卡片容器若有 transform（侧滑、缩放动画），
 * 会把 position:fixed 的弹窗「困」在容器里并裁切 —— 挂到 body 才永远铺满视口。
 */
export function ConfirmDangerDialog({
  open,
  title,
  children,
  confirmLabel = "确认",
  confirmDisabled,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  /** 确认按钮禁用（如未输密码 / 提交中），避免误触与重复提交 */
  confirmDisabled?: boolean;
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

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center p-4">
      {/* 遮罩 */}
      <div
        aria-hidden
        onClick={onCancel}
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
      />

      {/* 弹窗卡片：限制最大高度，内容多时内部滚动，绝不超出视口 */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="ac-dialog-pop relative w-full max-w-sm max-h-[min(86vh,34rem)] overflow-y-auto
                   rounded-card border border-line bg-surface shadow-pop"
      >
        {/* 红色警示头部 */}
        <header className="flex items-center gap-3 border-b border-line/60 bg-danger/5 px-4 py-3">
          {/* alert 三角 */}
          <svg
            className="h-5 w-5 flex-shrink-0 text-danger"
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
        <div className="px-4 py-3 text-sm text-ink-soft leading-relaxed">
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
            disabled={confirmDisabled}
            className="rounded-md px-3 py-1.5 text-sm font-medium text-white
                       bg-danger transition-all
                       hover:bg-danger/85
                       hover:shadow-[0_0_12px_rgba(250,81,81,0.35)]
                       disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:shadow-none"
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
