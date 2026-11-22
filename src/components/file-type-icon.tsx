import type { ReactNode } from "react";
import { fileIconKind, type FileIconKind } from "@/lib/file-icon";

/**
 * 文件类型图标：一枚带折角的彩色文档 + 白色类目图形。
 * 颜色和形状在 16px 的行内尺寸下仍能区分，替换原先清一色的 📄。
 */

const ICON_COLORS: Record<FileIconKind, string> = {
  image: "#8b5cf6",
  pdf: "#ef4444",
  video: "#ec4899",
  audio: "#f59e0b",
  word: "#2563eb",
  doc: "#1d4ed8",
  excel: "#16a34a",
  ppt: "#ea580c",
  markdown: "#0ea5e9",
  code: "#0891b2",
  web: "#0d9488",
  data: "#ca8a04",
  text: "#64748b",
  archive: "#a16207",
  other: "#94a3b8",
};

const TEXT_FONT = "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif";

function Glyph({ kind }: { kind: FileIconKind }): ReactNode {
  switch (kind) {
    case "image":
      return (
        <>
          <circle cx="9.1" cy="12.6" r="1.25" fill="#fff" />
          <path d="M6.8 18.7l3.1-3.7 2 2.2 1.7-1.9 3.1 3.4z" fill="#fff" />
        </>
      );
    case "video":
      return (
        <path
          d="M9.4 11.5a.85.85 0 0 1 1.3-.72l4.2 2.7a.85.85 0 0 1 0 1.44l-4.2 2.7a.85.85 0 0 1-1.3-.72z"
          fill="#fff"
        />
      );
    case "audio":
      return (
        <>
          <path
            d="M10.6 16.6V9.8l4-.9v6.8"
            fill="none"
            stroke="#fff"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
          <circle cx="9.3" cy="16.8" r="1.5" fill="#fff" />
          <circle cx="13.3" cy="15.9" r="1.5" fill="#fff" />
        </>
      );
    case "pdf":
      return (
        <text
          x="11.6"
          y="16.3"
          textAnchor="middle"
          fontFamily={TEXT_FONT}
          fontSize="6.6"
          fontWeight="700"
          letterSpacing="-0.2"
          fill="#fff"
        >
          PDF
        </text>
      );
    case "word":
      return (
        <text
          x="11.6"
          y="17.1"
          textAnchor="middle"
          fontFamily={TEXT_FONT}
          fontSize="10.5"
          fontWeight="700"
          fill="#fff"
        >
          W
        </text>
      );
    case "doc":
      return (
        <text
          x="11.6"
          y="16.4"
          textAnchor="middle"
          fontFamily={TEXT_FONT}
          fontSize="6.2"
          fontWeight="700"
          fill="#fff"
        >
          DOC
        </text>
      );
    case "excel":
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.15" strokeLinecap="round">
          <rect x="7.4" y="10.4" width="8.4" height="8" rx="1" />
          <path d="M7.4 13.1h8.4M7.4 15.8h8.4M11.6 10.4v8" />
        </g>
      );
    case "ppt":
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7.2" y="10" width="8.8" height="5.8" rx="1" />
          <path d="M11.6 15.8v2.6M9.6 18.4h4" />
          <path d="M9.1 13.8v-1.3M11.6 13.8v-2.2M14.1 13.8v-1.6" strokeWidth="0.95" />
        </g>
      );
    case "markdown":
      return (
        <>
          <text
            x="9.3"
            y="17.2"
            textAnchor="middle"
            fontFamily={TEXT_FONT}
            fontSize="8"
            fontWeight="700"
            fill="#fff"
          >
            M
          </text>
          <path
            d="M13.2 11v5.1m-1.8-1.9 1.8 1.9 1.8-1.9"
            fill="none"
            stroke="#fff"
            strokeWidth="1.35"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case "code":
      return (
        <path
          d="M9.6 11.3 7.2 14l2.4 2.7M13.6 11.3 16 14l-2.4 2.7M12.8 10l-1.3 8"
          fill="none"
          stroke="#fff"
          strokeWidth="1.35"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "web":
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.15" strokeLinecap="round">
          <circle cx="11.6" cy="14" r="3.7" />
          <path d="M7.9 14h7.4M11.6 10.3c1.8 2.1 1.8 5.3 0 7.4M11.6 10.3c-1.8 2.1-1.8 5.3 0 7.4" />
        </g>
      );
    case "data":
      return (
        <text
          x="11.6"
          y="16.9"
          textAnchor="middle"
          fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          fontSize="8"
          fontWeight="700"
          fill="#fff"
        >
          {"{}"}
        </text>
      );
    case "text":
      return (
        <path
          d="M8 11.6h7.2M8 14.4h7.2M8 17.2h4.6"
          fill="none"
          stroke="#fff"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      );
    case "archive":
      return (
        <g fill="none" stroke="#fff" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7.4" y="10.8" width="8.4" height="7.7" rx="1" />
          <path d="M10.9 10.8v7.7" />
          <path d="M9.6 12.4h2.6M9.6 14.2h2.6M9.6 16h2.6" strokeWidth="0.95" />
        </g>
      );
    case "other":
      return (
        <text
          x="11.6"
          y="17.2"
          textAnchor="middle"
          fontFamily={TEXT_FONT}
          fontSize="10"
          fontWeight="700"
          fill="#fff"
        >
          ?
        </text>
      );
  }
}

export function FileTypeIcon({
  filename,
  mimeType,
  className = "h-4 w-4",
  title,
}: {
  filename: string;
  mimeType?: string | null;
  className?: string;
  /** 传入后图标可被读屏识别并显示原生悬停提示；默认纯装饰 */
  title?: string;
}) {
  const kind = fileIconKind(filename, mimeType);
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path
        d="M6.2 2h7.1L19 7.7V20a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z"
        fill={ICON_COLORS[kind]}
      />
      <path d="M13.3 2v4.4a1.3 1.3 0 0 0 1.3 1.3H19" fill="#fff" fillOpacity="0.35" />
      <Glyph kind={kind} />
    </svg>
  );
}

export function FolderIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path
        d="M3.5 6.5A2 2 0 0 1 5.5 4.5h4l1.8 2h7.2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"
        fill="#f59e0b"
      />
      <path d="M3.5 9h17v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" fill="#fbbf24" />
    </svg>
  );
}
