"use client";

import * as XLSX from "xlsx";
import { AppError } from "@/lib/errors";
import { decodeTextWithFallback } from "@/lib/file-preview";
import {
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SHEET_MAX_SHEETS,
  type SheetBookType,
} from "./format";

/** 浏览器端表格读写（SheetJS）。直接改 worksheet 单元格对象，保留未编辑内容。 */

export type SheetBook = XLSX.WorkBook;

export function parseSheet(bytes: ArrayBuffer, bookType: SheetBookType): SheetBook {
  let wb: SheetBook;
  if (bookType === "csv") {
    const text = decodeTextWithFallback(bytes);
    wb = XLSX.read(text, { type: "string" });
  } else {
    wb = XLSX.read(new Uint8Array(bytes), { type: "array", cellDates: false });
  }
  ensureSheetLimits(wb);
  return wb;
}

export function ensureSheetLimits(wb: SheetBook): void {
  if (wb.SheetNames.length > SHEET_MAX_SHEETS) {
    throw new AppError(`最多支持 ${SHEET_MAX_SHEETS} 个工作表`);
  }
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    if (!ws?.["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    if (
      range.e.r - range.s.r + 1 > SHEET_MAX_ROWS ||
      range.e.c - range.s.c + 1 > SHEET_MAX_COLS
    ) {
      throw new AppError(`单个工作表最多 ${SHEET_MAX_ROWS} 行 × ${SHEET_MAX_COLS} 列`);
    }
  }
}

export function writeSheet(wb: SheetBook, bookType: SheetBookType): Uint8Array {
  if (bookType === "csv") {
    const text = XLSX.write(wb, {
      type: "string",
      bookType: "csv",
      sheet: wb.SheetNames[0],
    }) as string;
    return new TextEncoder().encode(`﻿${text}`);
  }
  const out = XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer;
  return new Uint8Array(out);
}

export function sheetRange(ws: XLSX.WorkSheet): { rows: number; cols: number } {
  if (!ws["!ref"]) return { rows: 0, cols: 0 };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  return {
    rows: range.e.r - range.s.r + 1,
    cols: range.e.c - range.s.c + 1,
  };
}

export function cellDisplay(ws: XLSX.WorkSheet, row: number, col: number): string {
  const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })] as
    | (XLSX.CellObject & { w?: string })
    | undefined;
  if (!cell) return "";
  if (typeof cell.w === "string") return cell.w;
  if (cell.v == null) return "";
  return String(cell.v);
}

export function cellRaw(ws: XLSX.WorkSheet, row: number, col: number): string {
  const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })] as
    | (XLSX.CellObject & { w?: string })
    | undefined;
  if (!cell) return "";
  if (cell.f) return `=${cell.f}`;
  if (cell.v == null) return "";
  return String(cell.v);
}

/**
 * 写入单元格：
 * - `=` 开头 → 公式（CSV 不支持公式，按文本存）
 * - 纯数字（无前导零）→ 数值
 * - 其它 → 文本
 * 保留原单元格的数字格式 `z`，其余样式可能丢失（v1 明确不做样式编辑）。
 */
export function setCellValue(
  ws: XLSX.WorkSheet,
  row: number,
  col: number,
  raw: string,
  bookType: SheetBookType,
): void {
  const addr = XLSX.utils.encode_cell({ r: row, c: col });
  const value = raw.trim();
  const old = ws[addr] as XLSX.CellObject | undefined;

  if (value === "") {
    delete ws[addr];
  } else if (bookType !== "csv" && value.startsWith("=") && value.length > 1) {
    const cell: XLSX.CellObject = { ...(old ?? {}), t: "n", f: value.slice(1) };
    delete (cell as { v?: unknown }).v;
    ws[addr] = cell;
  } else if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    ws[addr] = { ...(old ?? {}), t: "n", v: Number(value) };
  } else {
    ws[addr] = { ...(old ?? {}), t: "s", v: raw };
  }

  // 扩展 !ref，保证新写入的单元格被 SheetJS 保存
  const current = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  const next = current
    ? {
        s: { r: Math.min(current.s.r, row), c: Math.min(current.s.c, col) },
        e: { r: Math.max(current.e.r, row), c: Math.max(current.e.c, col) },
      }
    : { s: { r: row, c: col }, e: { r: row, c: col } };
  ws["!ref"] = XLSX.utils.encode_range(next);
}

export function markFullCalc(wb: SheetBook): void {
  // CalcPr 在 SheetJS 的类型里没声明，但写进 workbook 属性会被原样序列化
  wb.Workbook = {
    ...(wb.Workbook ?? {}),
    CalcPr: { fullCalcOnLoad: true },
  } as XLSX.WBProps;
}
