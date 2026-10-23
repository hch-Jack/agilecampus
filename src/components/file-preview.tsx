"use client";

import { useEffect, useState } from "react";
import {
  TEXT_PREVIEW_MAX_BYTES,
  decodeTextWithFallback,
  detectPreviewKind,
  renderMimeFor,
} from "@/lib/file-preview";
import type { SheetTable } from "@/lib/file-preview-office";

/** 预览目标：url 是现成的下载路由（带会话鉴权），组件内按需取内容 */
export type PreviewFile = {
  url: string;
  filename: string;
  mimeType?: string | null;
  size: number;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// 文件类型角标文案（弹窗标题左侧），不认识的一律归「文件」
function kindLabel(kind: ReturnType<typeof detectPreviewKind>): string {
  switch (kind) {
    case "image":
      return "图片";
    case "pdf":
      return "PDF";
    case "video":
      return "视频";
    case "audio":
      return "音频";
    case "text":
      return "文本";
    case "word":
      return "Word 文档";
    case "excel":
      return "Excel 表格";
    default:
      return "文件";
  }
}

/**
 * 附件在线预览弹窗：图片/PDF/视频/音频/文本免下载查看，其余格式提示下载。
 *
 * 取数方式：图片直接 <img src=下载路由>（浏览器带 cookie、可缓存）；
 * PDF/视频/音频 fetch 成 blob URL —— 下载路由恒为 attachment 响应，
 * iframe/媒体元素必须 blob + 正确 Content-Type 才能内置渲染，且不给
 * 任何 HTML/SVG 开内联口子；文本 fetch 后按 UTF-8/GBK 探测解码为纯文本展示。
 */
export function FilePreviewModal({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const kind = detectPreviewKind(file.filename, file.mimeType);
  const renderMime = renderMimeFor(file.filename, file.mimeType);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [wordHtml, setWordHtml] = useState<string | null>(null);
  const [sheets, setSheets] = useState<SheetTable[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState("");
  // 弹窗随打开全新挂载（file 在挂载期内不变），加载中 = 需要取内容但内容未到位
  const needsFetch = kind !== "image" && kind !== "unsupported";
  const loading =
    needsFetch && blobUrl === null && text === null && wordHtml === null && sheets === null && !error;

  // Esc 关闭；打开期间锁背景滚动
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  // pdf/video/audio/text 需要取内容；image 用下载 URL 直出，unsupported 不取
  useEffect(() => {
    if (kind === "image" || kind === "unsupported") return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(file.url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        if (kind === "text") {
          const capped = buf.byteLength > TEXT_PREVIEW_MAX_BYTES;
          setText(decodeTextWithFallback(capped ? buf.slice(0, TEXT_PREVIEW_MAX_BYTES) : buf));
          setTruncated(capped);
        } else if (kind === "word" || kind === "excel") {
          // Office 解析库（mammoth/SheetJS）体积大，动态 import 独立 chunk，只在此时加载
          const office = await import("@/lib/file-preview-office");
          if (cancelled) return;
          if (kind === "word") {
            setWordHtml(await office.docxToHtml(buf));
          } else {
            setSheets(await office.excelToSheets(buf));
          }
        } else {
          // 用补正后的 Content-Type 重建 blob，浏览器才会启用 PDF/媒体内置渲染
          objectUrl = URL.createObjectURL(new Blob([buf], { type: renderMime ?? "application/octet-stream" }));
          setBlobUrl(objectUrl);
        }
      } catch {
        if (!cancelled)
          setError(
            kind === "word" || kind === "excel" ? "文档解析失败，可下载后查看" : "内容加载失败，可下载后查看",
          );
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url, kind, renderMime]);

  const downloadBtn = (
    <a href={file.url} download={file.filename} className="ac-btn-ghost px-2.5 py-1 text-xs">
      下载
    </a>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${file.filename}`}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-field border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="shrink-0 text-xs text-ink-faint">{kindLabel(kind)}</span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={file.filename}>
            {file.filename}
          </span>
          <span className="shrink-0 text-xs text-ink-faint">{fmtSize(file.size)}</span>
          {downloadBtn}
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 px-1.5 text-lg leading-none text-ink-faint hover:text-ink"
            aria-label="关闭预览"
          >
            ×
          </button>
        </header>

        <div className="grid min-h-[240px] flex-1 place-items-center overflow-auto bg-sunken p-4">
          {error ? (
            <div className="text-center">
              <p className="text-sm text-high">{error}</p>
              {downloadBtn}
            </div>
          ) : kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={file.url}
              alt={file.filename}
              onError={() => setError("图片加载失败，可下载后查看")}
              className="max-h-[75vh] max-w-full rounded-field object-contain"
            />
          ) : loading ? (
            <p className="text-sm text-ink-faint">加载中…</p>
          ) : kind === "pdf" && blobUrl ? (
            // blob URL 由本站 fetch 的字节构建，且强制 application/pdf，无内联脚本风险
            <iframe src={blobUrl} title={file.filename} className="h-[75vh] w-full rounded-field bg-white" />
          ) : (kind === "video" || kind === "audio") && blobUrl ? (
            <div className="w-full">
              {kind === "video" ? (
                <video
                  src={blobUrl}
                  controls
                  autoPlay
                  onError={() => setError("该视频编码浏览器不支持播放，可下载后查看")}
                  className="max-h-[70vh] w-full rounded-field bg-black"
                />
              ) : (
                <audio
                  src={blobUrl}
                  controls
                  autoPlay
                  onError={() => setError("该音频浏览器不支持播放，可下载后查看")}
                  className="w-full"
                />
              )}
              <p className="mt-2 text-center text-xs text-ink-faint">打不开？下载后用本地播放器查看</p>
            </div>
          ) : kind === "text" && text !== null ? (
            <div className="h-full w-full">
              {truncated && (
                <p className="mb-2 text-xs text-ink-faint">
                  内容过长，仅显示前 {fmtSize(TEXT_PREVIEW_MAX_BYTES)}，下载可查看全文
                </p>
              )}
              <pre className="whitespace-pre-wrap break-words rounded-field border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-ink">
                {text}
              </pre>
            </div>
          ) : kind === "word" && wordHtml !== null ? (
            // 内容已过 sanitize（见 file-preview-office.ts），正文转义 + 去脚本节点
            <div
              className="h-full w-full overflow-auto rounded-field border border-line bg-surface p-6 text-sm leading-relaxed text-ink [&_a]:text-primary [&_a]:underline [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mb-1.5 [&_h4]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_ol]:my-2 [&_ol]:list-decimal [&_p]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-sunken [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc"
              dangerouslySetInnerHTML={{ __html: wordHtml }}
            />
          ) : kind === "excel" && sheets !== null ? (
            <div className="flex h-full w-full flex-col">
              {sheets.length > 1 && (
                <div className="flex flex-wrap gap-1 pb-2">
                  {sheets.map((s, i) => (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => setActiveSheet(i)}
                      className={`rounded-field px-2.5 py-1 text-xs ${
                        i === activeSheet
                          ? "bg-primary text-white"
                          : "border border-line bg-surface text-ink-soft hover:border-primary hover:text-primary"
                      }`}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              )}
              {sheets[activeSheet]?.truncated && (
                <p className="pb-2 text-xs text-ink-faint">
                  工作表过大，仅显示前 2000 行，下载可查看全部数据
                </p>
              )}
              <div
                className="min-h-0 w-full flex-1 overflow-auto rounded-field border border-line bg-surface [&_table]:border-collapse [&_table]:text-xs [&_td]:max-w-72 [&_td]:truncate [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_td]:whitespace-nowrap"
                dangerouslySetInnerHTML={{ __html: sheets[activeSheet]?.html ?? "" }}
              />
            </div>
          ) : (
            <div className="text-center">
              <p className="text-4xl" aria-hidden>
                📄
              </p>
              <p className="mt-2 text-sm text-ink-soft">该格式暂不支持在线预览</p>
              <div className="mt-3">{downloadBtn}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
