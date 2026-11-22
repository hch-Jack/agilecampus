"use client";

import type ExcelJS from "exceljs";
import { AppError } from "@/lib/errors";
import {
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  SHEET_MAX_SHEETS,
} from "./format";

/**
 * .xlsx 的浏览器端读写（ExcelJS，MIT）。
 *
 * 相比 SheetJS 社区版：ExcelJS 会完整加载并写回工作簿的样式、列宽、行高、
 * 合并单元格、数字格式、条件格式等，编辑单元格后不会把原排版洗掉。
 * 旧式 .xls / .csv 仍走 sheet.client.ts 的 SheetJS 路径（见 SheetEditor）。
 */

export type ExcelBook = ExcelJS.Workbook;

export async function loadExcelBook(bytes: ArrayBuffer): Promise<ExcelBook> {
  // 动态加载：ExcelJS 只在真正打开表格时下载，不再拖慢整个编辑页的首屏 chunk
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

/** 与 SheetJS 路径同一套上限；保存前再守一次 */
export function ensureExcelSheetLimits(wb: ExcelBook): void {
  if (wb.worksheets.length > SHEET_MAX_SHEETS) {
    throw new AppError(`最多支持 ${SHEET_MAX_SHEETS} 个工作表`);
  }
  for (const ws of wb.worksheets) {
    if (ws.rowCount > SHEET_MAX_ROWS || ws.columnCount > SHEET_MAX_COLS) {
      throw new AppError(`单个工作表最多 ${SHEET_MAX_ROWS} 行 × ${SHEET_MAX_COLS} 列`);
    }
  }
}

export function excelSheet(book: ExcelBook, index: number): ExcelJS.Worksheet | null {
  return book.worksheets[index] ?? null;
}

export function excelSheetNames(book: ExcelBook): string[] {
  return book.worksheets.map((ws) => ws.name);
}

export function excelRange(ws: ExcelJS.Worksheet): { rows: number; cols: number } {
  return {
    rows: ws.rowCount,
    cols: ws.columnCount,
  };
}

/** 展示文本：优先用 ExcelJS 的格式化文本（数字格式/日期格式都按原样） */
export function excelDisplay(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const cell = ws.getCell(row + 1, col + 1);
  const text = cell.text;
  return typeof text === "string" ? text : String(text ?? "");
}

/** 公式栏文本：公式带 =，其余取显示文本 */
export function excelRaw(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const cell = ws.getCell(row + 1, col + 1);
  const value = cell.value;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    if ("formula" in value && typeof value.formula === "string") {
      return `=${value.formula}`;
    }
    if ("richText" in value) {
      return excelDisplay(ws, row, col);
    }
  }
  return excelDisplay(ws, row, col);
}

export function excelSetCell(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  raw: string,
): void {
  const cell = ws.getCell(row + 1, col + 1);
  const value = raw.trim();
  if (value === "") {
    cell.value = null;
  } else if (value.startsWith("=") && value.length > 1) {
    cell.value = { formula: value.slice(1) };
  } else if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value)) {
    cell.value = Number(value);
  } else {
    cell.value = raw;
  }
}

// ExcelJS 的列宽单位是「字符数」，行高单位是「磅」。这里统一换算成 px 给 UI。
const CHAR_TO_PX = 7;
const CHAR_PAD = 5;
const PT_TO_PX = 4 / 3;

export const EXCELJS_MIN_COL_WIDTH = 32;
export const EXCELJS_MIN_ROW_HEIGHT = 18;
export const EXCELJS_DEFAULT_COL_WIDTH = 96;
export const EXCELJS_DEFAULT_ROW_HEIGHT = 28;

export function excelColWidth(ws: ExcelJS.Worksheet, col: number): number {
  const width = ws.getColumn(col + 1).width;
  return typeof width === "number"
    ? Math.round(width * CHAR_TO_PX + CHAR_PAD)
    : EXCELJS_DEFAULT_COL_WIDTH;
}

export function excelSetColWidth(ws: ExcelJS.Worksheet, col: number, px: number): void {
  ws.getColumn(col + 1).width = Math.max(1, (px - CHAR_PAD) / CHAR_TO_PX);
}

export function excelRowHeight(ws: ExcelJS.Worksheet, row: number): number {
  const height = ws.getRow(row + 1).height;
  return typeof height === "number"
    ? Math.round(height * PT_TO_PX)
    : EXCELJS_DEFAULT_ROW_HEIGHT;
}

export function excelSetRowHeight(ws: ExcelJS.Worksheet, row: number, px: number): void {
  ws.getRow(row + 1).height = px / PT_TO_PX;
}

export async function writeExcelBook(book: ExcelBook): Promise<Uint8Array> {
  // 公式结果在其它软件打开时重新计算
  book.calcProperties.fullCalcOnLoad = true;
  const buffer = await book.xlsx.writeBuffer();
  return new Uint8Array(buffer as ArrayBuffer);
}
