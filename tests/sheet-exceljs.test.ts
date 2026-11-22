import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  excelColWidth,
  excelDisplay,
  excelRaw,
  excelSetCell,
  excelSetColWidth,
  excelSheet,
  loadExcelBook,
  writeExcelBook,
} from "@/lib/documents/sheet-exceljs.client";

async function sourceBytes(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.getCell("A1").value = "原始内容";
  ws.getCell("A1").font = {
    name: "宋体",
    size: 16,
    bold: true,
    color: { argb: "FFFF0000" },
  };
  ws.getCell("A1").fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFFFFF00" },
  };
  ws.getCell("B2").value = { formula: "A1&\"!\"" };
  ws.getColumn(1).width = 20;
  ws.getRow(1).height = 30;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("ExcelJS 表格引擎", () => {
  it("编辑单元格后保留字体、填充、列宽与行高", async () => {
    const loaded = await loadExcelBook((await sourceBytes()) as unknown as ArrayBuffer);
    const sheet = excelSheet(loaded, 0)!;
    expect(excelDisplay(sheet, 0, 0)).toBe("原始内容");

    excelSetCell(sheet, 0, 0, "改过之后");
    excelSetColWidth(sheet, 0, 180);
    const out = await writeExcelBook(loaded);

    const check = new ExcelJS.Workbook();
    await check.xlsx.load(Buffer.from(out));
    const ws = check.getWorksheet("Sheet1")!;
    const cell = ws.getCell("A1");
    expect(cell.value).toBe("改过之后");
    expect(cell.font?.name).toBe("宋体");
    expect(cell.font?.bold).toBe(true);
    expect(cell.font?.color?.argb).toBe("FFFF0000");
    expect(cell.fill?.fgColor?.argb).toBe("FFFFFF00");
    expect(ws.getColumn(1).width).toBeCloseTo((180 - 5) / 7);
    expect(ws.getRow(1).height).toBeCloseTo(30);
  });

  it("公式保留为公式，读回仍是 =A1&\"!\"", async () => {
    const loaded = await loadExcelBook((await sourceBytes()) as unknown as ArrayBuffer);
    const sheet = excelSheet(loaded, 0)!;
    expect(excelRaw(sheet, 1, 1)).toBe('=A1&"!"');

    excelSetCell(sheet, 2, 0, "42");
    const check = new ExcelJS.Workbook();
    await check.xlsx.load(Buffer.from(await writeExcelBook(loaded)));
    const value = check.getWorksheet("Sheet1")!.getCell("B2").value as {
      formula?: string;
    };
    expect(value.formula).toBe('A1&"!"');
  });

  it("列宽换算可往返", async () => {
    const loaded = await loadExcelBook((await sourceBytes()) as unknown as ArrayBuffer);
    const sheet = excelSheet(loaded, 0)!;
    expect(excelColWidth(sheet, 0)).toBeGreaterThan(100);
  });
});
