import { AppError } from "@/lib/errors";
import type { SheetSpec } from "./document-spec";

/**
 * 助手生成 Excel。
 *
 * 两条路：给 `sheets` 结构（推荐，支持多工作表、列宽按内容自适应），
 * 或者给 `content` CSV（旧约定，第一行表头）。SheetJS 社区版不写单元格样式，
 * 所以这里能做的「排版」是把列宽、列数、表头行做到位，而不是配色。
 */

const INVALID_SHEET_NAME = /[[\]:*?/\\]/g;

export function safeSheetName(name: string | undefined, index: number): string {
  const cleaned = (name ?? "").replace(INVALID_SHEET_NAME, " ").trim().slice(0, 31);
  return cleaned || `Sheet${index + 1}`;
}

/** 显示宽度：中文按 2 个字符位算，夹到 8–48 */
function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += char.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return Math.min(48, Math.max(8, width + 2));
}

export async function xlsxFromCsv(content: string, sheetName?: string): Promise<Buffer> {
  const XLSX = await import("xlsx");
  let workbook;
  try {
    // type:string 让 SheetJS 自己识别分隔符（逗号/制表符）与引号
    workbook = XLSX.read(content, { type: "string" });
  } catch {
    throw new AppError("Excel 内容需为 CSV 文本（第一行作表头）");
  }
  if (sheetName?.trim()) {
    const old = workbook.SheetNames[0];
    const name = safeSheetName(sheetName, 0);
    workbook.SheetNames[0] = name;
    workbook.Sheets[name] = workbook.Sheets[old];
    if (name !== old) delete workbook.Sheets[old];
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export async function xlsxFromSheets(sheets: SheetSpec[]): Promise<Buffer> {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const used = new Set<string>();

  sheets.forEach((sheet, index) => {
    let name = safeSheetName(sheet.name, index);
    // 工作表名不能重复（不区分大小写），撞了就加序号
    let suffix = 2;
    while (used.has(name.toLowerCase())) {
      const base = name.slice(0, 28);
      name = `${base}(${suffix})`.slice(0, 31);
      suffix += 1;
    }
    used.add(name.toLowerCase());

    const rows: string[][] = [];
    if (sheet.headers && sheet.headers.length > 0) rows.push(sheet.headers);
    rows.push(...sheet.rows);
    const worksheet = XLSX.utils.aoa_to_sheet(rows);

    const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (colCount > 0) {
      const widths: { wch: number }[] = [];
      for (let col = 0; col < colCount; col++) {
        let width = 8;
        for (const row of rows.slice(0, 500)) {
          width = Math.max(width, displayWidth(row[col] ?? ""));
        }
        widths.push({ wch: width });
      }
      worksheet["!cols"] = widths;
    }
    // 社区版不写单元格样式，表头只能靠位置与列宽区分
    XLSX.utils.book_append_sheet(workbook, worksheet, name);
  });

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
