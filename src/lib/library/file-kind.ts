import { detectPreviewKind, extOf } from "@/lib/file-preview";

export const LIBRARY_FILE_TYPES = [
  "all",
  "document",
  "spreadsheet",
  "presentation",
  "pdf",
  "image",
  "video",
  "audio",
  "text",
  "archive",
  "other",
] as const;

export type LibraryFileType = (typeof LIBRARY_FILE_TYPES)[number];

export const LIBRARY_FILE_TYPE_LABELS: Record<LibraryFileType, string> = {
  all: "全部类型",
  document: "文档",
  spreadsheet: "表格",
  presentation: "演示文稿",
  pdf: "PDF",
  image: "图片",
  video: "视频",
  audio: "音频",
  text: "文本 / 代码",
  archive: "压缩包",
  other: "其他",
};

const ARCHIVE_EXTS = new Set([
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "xz",
  "zst",
]);

/** Windows 资源管理器式的文件类型分类 */
export function libraryFileType(
  filename: string,
  mimeType?: string | null,
): LibraryFileType {
  const kind = detectPreviewKind(filename, mimeType);
  switch (kind) {
    case "word":
    case "doc":
      return "document";
    case "excel":
      return "spreadsheet";
    case "ppt":
      return "presentation";
    case "pdf":
      return "pdf";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "text":
      return "text";
    default:
      return ARCHIVE_EXTS.has(extOf(filename)) ? "archive" : "other";
  }
}

export function libraryFileTypeLabel(
  filename: string,
  mimeType?: string | null,
): string {
  return LIBRARY_FILE_TYPE_LABELS[libraryFileType(filename, mimeType)];
}

export function isLibraryFileType(value: unknown): value is LibraryFileType {
  return (
    typeof value === "string" &&
    (LIBRARY_FILE_TYPES as readonly string[]).includes(value)
  );
}
