import { detectPreviewKind, extOf } from "@/lib/file-preview";
import type { DocumentFormat } from "./types";

/**
 * 在线编辑的格式判定（客户端安全：不 import 任何 Node 内置模块）。
 *
 * 与预览口径刻意分开：CSV 预览仍按纯文本展示，编辑时归为表格；
 * 宏/模板类 Office、PPT、PDF、图片、音视频一律只读并给出明确原因。
 * 超过大小上限也直接只读——绝不截断后允许保存，避免静默丢数据。
 */

export const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;
export const DOCX_EDIT_MAX_BYTES = 20 * 1024 * 1024;
export const SHEET_EDIT_MAX_BYTES = 10 * 1024 * 1024;
export const SHEET_MAX_ROWS = 5000;
export const SHEET_MAX_COLS = 100;
export const SHEET_MAX_SHEETS = 20;
export const DOCX_IMAGE_TOTAL_MAX_BYTES = 5 * 1024 * 1024;

export type SheetBookType = "xlsx" | "xls" | "csv";

export type EditableInfo =
  | { editable: true; format: DocumentFormat; bookType?: SheetBookType; maxBytes: number }
  | { editable: false; reason: string };

const EDITABLE_SHEET_EXTS: Record<string, SheetBookType> = {
  xlsx: "xlsx",
  xls: "xls",
  csv: "csv",
};

const READ_ONLY_OFFICE_REASON =
  "启用宏的工作簿、模板与 ODS 暂不支持在线编辑（避免破坏宏/模板），可下载后在本地编辑再上传";

export function detectEditableFormat(
  filename: string,
  mimeType?: string | null,
  size?: number,
): EditableInfo {
  const ext = extOf(filename);
  const kind = detectPreviewKind(filename, mimeType);
  const tooBig = (max: number, label: string): EditableInfo | null =>
    typeof size === "number" && size > max
      ? { editable: false, reason: `文件超过在线编辑上限 ${label}，请下载后用本地软件编辑` }
      : null;

  if (kind === "text") {
    if (EDITABLE_SHEET_EXTS[ext]) {
      const blocked = tooBig(SHEET_EDIT_MAX_BYTES, "10MB");
      if (blocked) return blocked;
      return {
        editable: true,
        format: "sheet",
        bookType: EDITABLE_SHEET_EXTS[ext],
        maxBytes: SHEET_EDIT_MAX_BYTES,
      };
    }
    const blocked = tooBig(TEXT_EDIT_MAX_BYTES, "2MB");
    if (blocked) return blocked;
    return { editable: true, format: "text", maxBytes: TEXT_EDIT_MAX_BYTES };
  }

  if (kind === "word") {
    if (ext !== "docx") {
      return {
        editable: false,
        reason: "仅 .docx 支持在线编辑；模板或启用宏的 Word 文档请下载后在本地编辑",
      };
    }
    const blocked = tooBig(DOCX_EDIT_MAX_BYTES, "20MB");
    if (blocked) return blocked;
    return { editable: true, format: "docx", maxBytes: DOCX_EDIT_MAX_BYTES };
  }

  if (kind === "excel") {
    const bookType = EDITABLE_SHEET_EXTS[ext];
    if (!bookType) return { editable: false, reason: READ_ONLY_OFFICE_REASON };
    const blocked = tooBig(SHEET_EDIT_MAX_BYTES, "10MB");
    if (blocked) return blocked;
    return { editable: true, format: "sheet", bookType, maxBytes: SHEET_EDIT_MAX_BYTES };
  }

  if (kind === "ppt") return { editable: false, reason: "PPT 暂不支持在线编辑，可下载后编辑" };
  if (kind === "doc") return { editable: false, reason: "旧版 .doc 仅支持只读预览，请另存为 .docx 后上传" };
  if (kind === "pdf") return { editable: false, reason: "PDF 暂不支持在线编辑" };
  if (kind === "image") return { editable: false, reason: "图片暂不支持在线编辑" };
  if (kind === "video" || kind === "audio") {
    return { editable: false, reason: "音视频文件不支持在线编辑" };
  }
  return { editable: false, reason: "该格式暂不支持在线编辑" };
}

/** 另存为时用：判断新文件名是否仍落在同一编辑格式族 */
export function isSameEditableFormat(
  originalFilename: string,
  nextFilename: string,
  format: DocumentFormat,
): boolean {
  const info = detectEditableFormat(nextFilename);
  if (!info.editable || info.format !== format) return false;
  // csv 另存为 xlsx 属于跨格式转换，不在 v1 范围；扩展名必须一致
  if (format === "sheet") {
    return extOf(originalFilename) === extOf(nextFilename);
  }
  if (format === "docx") return extOf(nextFilename) === "docx";
  return true;
}

export function sheetBookTypeOf(filename: string): SheetBookType | null {
  return EDITABLE_SHEET_EXTS[extOf(filename)] ?? null;
}

export function formatLabel(format: DocumentFormat): string {
  switch (format) {
    case "text":
      return "文本";
    case "docx":
      return "Word";
    case "sheet":
      return "表格";
  }
}
