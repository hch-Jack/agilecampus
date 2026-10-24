"use client";

import { useEffect, useRef, useState } from "react";
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
    case "doc":
      return "Word 文档（旧版）";
    case "excel":
      return "Excel 表格";
    case "ppt":
      return "PPT 幻灯片";
    default:
      return "文件";
  }
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

/**
 * 附件在线预览弹窗：图片/PDF/音视频/文本代码/Word/Excel/PPT 免下载查看。
 *
 * 取数方式：图片直接 <img src=下载路由>（浏览器带 cookie、可缓存）；
 * PDF/视频/音频 fetch 成 blob URL —— 下载路由恒为 attachment 响应，
 * iframe/媒体元素必须 blob + 正确 Content-Type 才能内置渲染，且不给
 * 任何 HTML/SVG 开内联口子；文本 fetch 后按 UTF-8/GBK 探测解码为纯文本展示；
 * Office 文件按格式走 docx-preview / SheetJS / pptx-preview（都是动态 import）。
 *
 * 统一版式：所有类型共用一个接近全屏的弹窗（96vw × 92vh），内容区撑满，
 * 不再为 PPT/文档留一个只够显示一条的窄条。
 */
export function FilePreviewModal({ file, onClose }: { file: PreviewFile; onClose: () => void }) {
  const kind = detectPreviewKind(file.filename, file.mimeType);
  const renderMime = renderMimeFor(file.filename, file.mimeType);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [wordHtml, setWordHtml] = useState<string | null>(null);
  const [wordReady, setWordReady] = useState(false);
  const [sheets, setSheets] = useState<SheetTable[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [pptBuf, setPptBuf] = useState<ArrayBuffer | null>(null);
  const [pptWidth, setPptWidth] = useState(0);
  const [pptReady, setPptReady] = useState(false);
  const [error, setError] = useState("");

  // Word：docx-preview 直接往 body 容器建 DOM，样式写进 style 容器（卸载即清空）
  const wordBodyRef = useRef<HTMLDivElement>(null);
  const wordStyleRef = useRef<HTMLDivElement>(null);
  // PPT：pptx-preview 往容器里铺幻灯片；其 destroy() 不清 DOM，重建前自行清空
  const pptHostRef = useRef<HTMLDivElement>(null);
  const pptPreviewerRef = useRef<{ destroy: () => void } | null>(null);

  const isLoading =
    !error &&
    kind !== "image" &&
    kind !== "unsupported" &&
    (kind === "word"
      ? !wordReady && wordHtml === null
      : kind === "excel"
        ? sheets === null
        : kind === "ppt"
          ? !pptReady
          : text === null && blobUrl === null);

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

  // 文本 / 代码 / PDF / 音视频 / Word / Excel 取内容；image 直出，PPT 走下方独立流程
  useEffect(() => {
    if (kind === "image" || kind === "ppt" || kind === "unsupported") return;
    let cancelled = false;
    let objectUrl: string | null = null;
    (async () => {
      try {
        const res = await fetch(file.url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        if (kind === "text" || kind === "doc") {
          const capped = buf.byteLength > TEXT_PREVIEW_MAX_BYTES;
          if (kind === "doc") {
            // 旧版 .doc 二进制：CFB 抽正文（排版/图片无法还原）
            const office = await import("@/lib/file-preview-office");
            if (cancelled) return;
            setText(office.legacyDocToText(buf));
          } else {
            setText(decodeTextWithFallback(capped ? buf.slice(0, TEXT_PREVIEW_MAX_BYTES) : buf));
          }
          setTruncated(capped);
        } else if (kind === "word") {
          // docx-preview 保真渲染；解析失败再退回 mammoth 的语义 HTML
          const office = await import("@/lib/file-preview-office");
          if (cancelled) return;
          const bodyEl = wordBodyRef.current;
          const styleEl = wordStyleRef.current;
          try {
            if (!bodyEl || !styleEl) throw new Error("container missing");
            await office.renderDocx(buf, bodyEl, styleEl);
            if (!cancelled) setWordReady(true);
          } catch {
            const html = await office.docxToHtml(buf);
            if (!cancelled) setWordHtml(html);
          }
        } else if (kind === "excel") {
          const office = await import("@/lib/file-preview-office");
          if (cancelled) return;
          setSheets(await office.excelToSheets(buf));
        } else {
          // 用补正后的 Content-Type 重建 blob，浏览器才会启用 PDF/媒体内置渲染
          objectUrl = URL.createObjectURL(new Blob([buf], { type: renderMime ?? "application/octet-stream" }));
          setBlobUrl(objectUrl);
        }
      } catch {
        if (!cancelled) setError(kind === "doc" ? "文档解析失败，可下载后查看" : "内容加载失败，可下载后查看");
      }
    })();
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.url, kind, renderMime]);

  // PPT：先取字节，再按容器宽度渲染。宽度用 ResizeObserver 跟（防抖带迟滞，
  // 滚动条出现引起的十几像素变化不触发重排）。
  useEffect(() => {
    if (kind !== "ppt") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(file.url);
        if (!res.ok) throw new Error(String(res.status));
        const buf = await res.arrayBuffer();
        if (!cancelled) setPptBuf(buf);
      } catch {
        if (!cancelled) setError("文档解析失败，可下载后查看");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.url, kind]);

  useEffect(() => {
    if (kind !== "ppt") return;
    const el = pptHostRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0].contentRect.width);
      if (width <= 0) return;
      setPptWidth((prev) => (prev === 0 || Math.abs(prev - width) > 40 ? width : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [kind]);

  useEffect(() => {
    if (kind !== "ppt" || !pptBuf || pptWidth <= 0) return;
    const el = pptHostRef.current;
    if (!el) return;
    let cancelled = false;
    (async () => {
      try {
        const { init } = await import("pptx-preview");
        if (cancelled) return;
        el.replaceChildren();
        // list 模式：每页按容器宽度等比缩放、纵向连排；宽度决定幻灯片大小
        const previewer = init(el, {
          width: pptWidth,
          height: Math.round((pptWidth * 9) / 16),
          mode: "list",
        });
        pptPreviewerRef.current = previewer;
        await previewer.preview(pptBuf);
        // 解析器对残缺文件（如 Content_Types 声明了不存在的部件）会静默返回 0 页，
        // 不抛错——不拦就会留一个黑框，所以按「没解出幻灯片」算失败，引导下载。
        if (previewer.slideCount === 0) throw new Error("empty presentation");
        // list 模式下库把 wrapper 固定成初始化时的高度并自己滚，外层容器再滚会出现
        // 双滚动条、底部还会被裁掉几像素；改成自适应高度，滚动统一交给外层。
        previewer.wrapper.style.height = "auto";
        previewer.wrapper.style.overflowY = "visible";
        if (!cancelled) setPptReady(true);
      } catch {
        if (!cancelled) setError("文档解析失败，可下载后查看");
      }
    })();
    return () => {
      cancelled = true;
      pptPreviewerRef.current?.destroy();
      pptPreviewerRef.current = null;
    };
  }, [kind, pptBuf, pptWidth]);

  const downloadBtn = (
    <a href={file.url} download={file.filename} className="ac-btn-ghost shrink-0 px-2.5 py-1 text-xs">
      下载
    </a>
  );

  const unsupportedHint =
    extOf(file.filename) === "ppt"
      ? "旧版 .ppt 暂不支持在线预览，请下载后用 PowerPoint / WPS 打开"
      : "该格式暂不支持在线预览";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-5"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${file.filename}`}
    >
      {/* 宇宙主题的 --color-surface 只有 45% 不透明度，弹窗会透出星空与页面文字；
          project.css 给 .ac-file-preview 单独压厚（浅色主题仍是纯白 surface） */}
      <div
        className="ac-file-preview flex h-[92vh] max-h-[1000px] w-[min(96vw,1440px)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 sm:px-4 sm:py-2.5">
          <span className="shrink-0 rounded bg-sunken px-1.5 py-0.5 text-[11px] text-ink-soft">
            {kindLabel(kind)}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink" title={file.filename}>
            {file.filename}
          </span>
          <span className="hidden shrink-0 text-xs text-ink-faint sm:inline">{fmtSize(file.size)}</span>
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

        <div className="relative flex min-h-0 flex-1 flex-col bg-sunken">
          {kind === "image" && (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.url}
                alt={file.filename}
                onError={() => setError("图片加载失败，可下载后查看")}
                className="max-h-full max-w-full rounded-field object-contain"
              />
            </div>
          )}

          {kind === "pdf" && blobUrl && (
            // blob URL 由本站 fetch 的字节构建，且强制 application/pdf，无内联脚本风险
            <iframe src={blobUrl} title={file.filename} className="h-full w-full border-0 bg-white" />
          )}

          {(kind === "video" || kind === "audio") && blobUrl && (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-auto p-4">
              {kind === "video" ? (
                <video
                  src={blobUrl}
                  controls
                  autoPlay
                  onError={() => setError("该视频编码浏览器不支持播放，可下载后查看")}
                  className="max-h-full max-w-full rounded-field bg-black"
                />
              ) : (
                <audio
                  src={blobUrl}
                  controls
                  autoPlay
                  onError={() => setError("该音频浏览器不支持播放，可下载后查看")}
                  className="w-full max-w-xl"
                />
              )}
              <p className="text-xs text-ink-faint">打不开？下载后用本地播放器查看</p>
            </div>
          )}

          {(kind === "text" || kind === "doc") && text !== null && (
            <div className="flex min-h-0 flex-1 flex-col">
              {kind === "doc" && (
                <p className="shrink-0 border-b border-line bg-surface px-4 py-1.5 text-xs text-ink-faint">
                  旧版 .doc 只能提取正文文本，排版、图片与表格样式无法还原；需要完整版式请下载后查看
                </p>
              )}
              {truncated && (
                <p className="shrink-0 border-b border-line bg-surface px-4 py-1.5 text-xs text-ink-faint">
                  内容过长，仅显示前 {fmtSize(TEXT_PREVIEW_MAX_BYTES)}，下载可查看全文
                </p>
              )}
              <div className="min-h-0 flex-1 overflow-auto p-3">
                <pre className="min-h-full whitespace-pre-wrap break-words rounded-field border border-line bg-surface p-4 font-mono text-[13px] leading-relaxed text-ink [tab-size:4]">
                  {text}
                </pre>
              </div>
            </div>
          )}

          {kind === "word" && (
            <div className="min-h-0 flex-1 overflow-auto bg-neutral-100 p-3 sm:p-4">
              <div ref={wordStyleRef} />
              <div
                ref={wordBodyRef}
                className="mx-auto [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-0 [&_section.docx]:mx-auto [&_section.docx]:mb-4 [&_section.docx]:shadow-md"
              />
              {wordHtml !== null && (
                // mammoth 兜底：内容已过 sanitize（见 file-preview-office.ts）
                <div
                  className="mx-auto w-full max-w-4xl rounded-field border border-line bg-white p-6 text-sm leading-relaxed text-neutral-900 [&_a]:text-primary [&_a]:underline [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-bold [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold [&_h4]:mb-1.5 [&_h4]:font-semibold [&_img]:max-w-full [&_li]:ml-5 [&_ol]:my-2 [&_ol]:list-decimal [&_p]:my-2 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-line [&_th]:bg-sunken [&_th]:px-2 [&_th]:py-1 [&_ul]:my-2 [&_ul]:list-disc"
                  dangerouslySetInnerHTML={{ __html: wordHtml }}
                />
              )}
            </div>
          )}

          {kind === "excel" && sheets !== null && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-line bg-surface px-2 py-1.5">
                {sheets.length > 1 &&
                  sheets.map((s, i) => (
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
                {(sheets[activeSheet]?.truncated || sheets[activeSheet]?.colsTruncated) && (
                  <span className="ml-auto px-1 text-xs text-ink-faint">
                    {sheets[activeSheet]?.truncated ? "仅显示前 2000 行" : "列较多，仅显示前 120 列"}
                    ，下载可查看全部数据
                  </span>
                )}
              </div>
              <div
                className="min-h-0 flex-1 overflow-auto bg-white p-2 text-neutral-900 sm:p-3 [&_table]:border-collapse [&_table]:text-xs [&_table]:text-neutral-900 [&_td]:border [&_td]:border-neutral-200 [&_td]:px-2 [&_td]:py-0.5"
                dangerouslySetInnerHTML={{ __html: sheets[activeSheet]?.html ?? "" }}
              />
            </div>
          )}

          {kind === "ppt" && (
            <div className="min-h-0 flex-1 p-2 sm:p-3">
              <div
                ref={pptHostRef}
                className="h-full w-full overflow-y-auto rounded-field border border-line bg-white/60"
              />
            </div>
          )}

          {kind === "unsupported" && (
            <div className="grid min-h-0 flex-1 place-items-center p-6">
              <div className="text-center">
                <p className="text-4xl" aria-hidden>
                  📄
                </p>
                <p className="mt-2 text-sm text-ink-soft">{unsupportedHint}</p>
                <div className="mt-3">{downloadBtn}</div>
              </div>
            </div>
          )}

          {isLoading && (
            <div className="absolute inset-0 grid place-items-center bg-sunken/85 text-sm text-ink-faint">
              加载中…
            </div>
          )}

          {error && (
            <div className="absolute inset-0 grid place-items-center bg-sunken p-6">
              <div className="text-center">
                <p className="text-sm text-high">{error}</p>
                <div className="mt-3">{downloadBtn}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
