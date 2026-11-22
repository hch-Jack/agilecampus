"use client";

import { useEffect, useRef, useState } from "react";
import { FolderIcon } from "@/components/file-type-icon";

/**
 * 统一的「添加附件」按钮：点开后向上弹出菜单，二选一——
 * 本地上传 / 从资源库选取。助手面板、任务附件、私信/群聊附件共用，
 * 避免各处的上传入口各长一套。
 */

function PaperclipIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 11.5l-8.6 8.6a5 5 0 01-7.1-7.1l9-9a3.4 3.4 0 014.8 4.8l-9 9a1.8 1.8 0 01-2.5-2.5l8.2-8.2" />
    </svg>
  );
}

function UploadIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function AttachmentSourceButton({
  onLocal,
  onLibrary,
  disabled = false,
  busy = false,
  title = "添加附件",
  text,
  className = "ac-btn-ghost shrink-0 px-2 py-2 text-sm",
}: {
  /** 选「本地上传」时由调用方打开自己的文件选择框 */
  onLocal: () => void;
  /** 选「从资源库选取」时由调用方打开资源库弹窗 */
  onLibrary: () => void;
  disabled?: boolean;
  /** 上传/提交中：按钮只显示省略号，避免误导 */
  busy?: boolean;
  title?: string;
  /** 需要文字标签时传入，如「添加附件」；不传则只有回形针图标 */
  text?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={title}
        title={title}
        className={className}
      >
        {busy ? (
          <span className="inline-flex items-center justify-center text-xs text-ink-faint">…</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <PaperclipIcon />
            {text && <span className="whitespace-nowrap">{text}</span>}
          </span>
        )}
      </button>
      {open && !disabled && !busy && (
        <div
          role="menu"
          className="ac-pop-up-in absolute bottom-full left-0 z-50 mb-1 w-44 overflow-hidden rounded-field border border-line bg-surface/85 py-1 shadow-pop backdrop-blur"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLocal();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink hover:bg-sunken"
          >
            <UploadIcon />
            本地上传
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLibrary();
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink hover:bg-sunken"
          >
            <FolderIcon className="h-4 w-4" />
            从资源库选取
          </button>
        </div>
      )}
    </div>
  );
}
