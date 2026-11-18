"use client";

import type { AssistantFile } from "@/lib/agent/assistant-panel-shared";

/**
 * 助手消息下方的文件卡。
 *
 * 原来是一枚 `预览 xxx` 小胶囊：字小、不显眼，想下载还得先点开预览再点弹窗里的下载。
 * 现在做成整行卡片 —— 文件名一眼可读，右侧并排「预览」「下载」，**下载一步到位**。
 */

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function kindLabel(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toUpperCase() : "";
  if (!ext) return "FILE";
  return ext.length > 4 ? ext.slice(0, 4) : ext;
}

export function AssistantFileCards({
  files,
  onPreview,
}: {
  files: AssistantFile[];
  /** 交给外壳打开预览弹窗；与原来的预览入口是同一套 */
  onPreview: (file: AssistantFile) => void;
}) {
  return (
    <ul className="mt-2 space-y-1.5">
      {files.map((file) => (
        <li
          key={file.url}
          className="flex items-center gap-2.5 rounded-field border border-line bg-surface px-2.5 py-2 transition-colors hover:border-line-strong sm:px-3"
        >
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded bg-primary-soft text-[10px] font-bold tracking-wide text-primary"
          >
            {kindLabel(file.filename)}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink" title={file.filename}>
              {file.filename}
            </span>
            <span className="block text-[11px] text-ink-faint">
              {formatSize(file.size)}
              <span className="mx-1">·</span>
              可直接下载
            </span>
          </span>
          <button
            type="button"
            onClick={() => onPreview(file)}
            className="ac-btn-ghost shrink-0 px-2.5 py-1.5 text-xs sm:px-3"
          >
            预览
          </button>
          <a
            href={file.url}
            download={file.filename}
            title={`下载 ${file.filename}`}
            className="ac-btn shrink-0 px-3 py-1.5 text-xs sm:px-3.5"
          >
            下载
          </a>
        </li>
      ))}
    </ul>
  );
}
