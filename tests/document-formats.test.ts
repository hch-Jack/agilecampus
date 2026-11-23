import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import mammoth from "mammoth";
import { decodeTextWithFallback } from "@/lib/file-preview";
import {
  DOCX_EDIT_MAX_BYTES,
  SHEET_EDIT_MAX_BYTES,
  TEXT_EDIT_MAX_BYTES,
  detectEditableFormat,
  isSameEditableFormat,
  sheetBookTypeOf,
} from "@/lib/documents/format";
import {
  cellDisplay,
  cellRaw,
  ensureSheetLimits,
  markFullCalc,
  parseSheet,
  setCellValue,
  writeSheet,
} from "@/lib/documents/sheet.client";
import { exportTiptapToDocx } from "@/lib/documents/docx-export";
import { parseTiptapDoc, tiptapDocText } from "@/lib/documents/tiptap";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("detectEditableFormat：哪些文件能在线编辑", () => {
  it("文本 / Markdown / 代码按 text 编辑", () => {
    expect(detectEditableFormat("notes.txt")).toMatchObject({
      editable: true,
      format: "text",
      maxBytes: TEXT_EDIT_MAX_BYTES,
    });
    expect(detectEditableFormat("README.md", "text/markdown")).toMatchObject({
      editable: true,
      format: "text",
    });
    expect(detectEditableFormat("main.ts")).toMatchObject({ editable: true, format: "text" });
    expect(detectEditableFormat("schema.json")).toMatchObject({
      editable: true,
      format: "text",
    });
  });

  it("CSV 归表格（即使预览是纯文本）", () => {
    expect(detectEditableFormat("data.csv", "text/csv")).toEqual({
      editable: true,
      format: "sheet",
      bookType: "csv",
      maxBytes: SHEET_EDIT_MAX_BYTES,
    });
    expect(sheetBookTypeOf("data.csv")).toBe("csv");
  });

  it("docx / xlsx / xls 可编辑", () => {
    expect(detectEditableFormat("报告.docx")).toMatchObject({
      editable: true,
      format: "docx",
      maxBytes: DOCX_EDIT_MAX_BYTES,
    });
    expect(detectEditableFormat("统计.xlsx")).toMatchObject({
      editable: true,
      format: "sheet",
      bookType: "xlsx",
    });
    expect(detectEditableFormat("旧表.xls")).toMatchObject({
      editable: true,
      format: "sheet",
      bookType: "xls",
    });
  });

  it("只读格式给出明确原因", () => {
    const cases: [string, string][] = [
      ["旧文档.doc", "docx"],
      ["启用宏.xlsm", "宏"],
      ["幻灯片.pptx", "PPT"],
      ["扫描.pdf", "PDF"],
      ["图片.png", "图片"],
      ["视频.mp4", "音视频"],
      ["未知.xyz", "暂不支持"],
    ];
    for (const [filename, hint] of cases) {
      const info = detectEditableFormat(filename);
      expect(info.editable).toBe(false);
      if (!info.editable) expect(info.reason).toContain(hint);
    }
  });

  it("超过大小上限一律只读，不截断", () => {
    const text = detectEditableFormat("big.txt", "text/plain", TEXT_EDIT_MAX_BYTES + 1);
    expect(text.editable).toBe(false);
    if (!text.editable) expect(text.reason).toContain("2MB");

    const sheet = detectEditableFormat("big.xlsx", null, SHEET_EDIT_MAX_BYTES + 1);
    expect(sheet.editable).toBe(false);
    if (!sheet.editable) expect(sheet.reason).toContain("10MB");

    const docx = detectEditableFormat("big.docx", null, DOCX_EDIT_MAX_BYTES + 1);
    expect(docx.editable).toBe(false);
    if (!docx.editable) expect(docx.reason).toContain("20MB");
  });
});

describe("isSameEditableFormat：另存为的扩展名约束", () => {
  it("文本格式内可换扩展名", () => {
    expect(isSameEditableFormat("notes.txt", "notes.md", "text")).toBe(true);
    expect(isSameEditableFormat("notes.txt", "notes.pdf", "text")).toBe(false);
  });

  it("表格 / docx 扩展名必须一致", () => {
    expect(isSameEditableFormat("book.xlsx", "副本.xlsx", "sheet")).toBe(true);
    expect(isSameEditableFormat("book.xlsx", "副本.xls", "sheet")).toBe(false);
    expect(isSameEditableFormat("book.csv", "副本.xlsx", "sheet")).toBe(false);
    expect(isSameEditableFormat("doc.docx", "副本.docx", "docx")).toBe(true);
    expect(isSameEditableFormat("doc.docx", "副本.doc", "docx")).toBe(false);
  });
});

describe("文本解码：GBK 兼容", () => {
  it("UTF-8 原样读出", () => {
    const bytes = new TextEncoder().encode("中文内容");
    expect(decodeTextWithFallback(toArrayBuffer(bytes))).toBe("中文内容");
  });

  it("GBK 字节回退解码", () => {
    // GBK：「中」= D6 D0，「文」= CE C4
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeTextWithFallback(toArrayBuffer(gbk))).toBe("中文");
  });

  it("空内容返回空串", () => {
    expect(decodeTextWithFallback(new ArrayBuffer(0))).toBe("");
  });
});

describe("SheetJS 表格读写", () => {
  function workbook() {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["名称", "数量"],
      ["器材", 3],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "清单");
    return { wb, ws };
  }

  it("CSV 写出带 BOM，读回中文不乱码", () => {
    const { wb } = workbook();
    const bytes = writeSheet(wb, "csv");
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);

    const parsed = parseSheet(toArrayBuffer(bytes), "csv");
    const ws = parsed.Sheets[parsed.SheetNames[0]];
    expect(cellDisplay(ws, 0, 0)).toBe("名称");
    expect(cellDisplay(ws, 1, 0)).toBe("器材");
    expect(cellRaw(ws, 1, 1)).toBe("3");
  });

  it("公式写入后在 xlsx 往返中保留", () => {
    const { wb, ws } = workbook();
    setCellValue(ws, 0, 2, "=B2*2", "xlsx");
    markFullCalc(wb);

    const bytes = writeSheet(wb, "xlsx");
    const parsed = parseSheet(toArrayBuffer(bytes), "xlsx");
    const round = parsed.Sheets["清单"];
    expect(cellRaw(round, 0, 2)).toBe("=B2*2");
    expect(round.C1.f).toBe("B2*2");
  });

  it("数字保持数值类型，前导零按文本存", () => {
    const { ws } = workbook();
    setCellValue(ws, 1, 1, "42", "xlsx");
    expect(ws.B2).toMatchObject({ t: "n", v: 42 });
    setCellValue(ws, 2, 0, "007", "xlsx");
    expect(ws.A3).toMatchObject({ t: "s", v: "007" });
  });

  it("CSV 不支持公式，按文本写入", () => {
    const { ws } = workbook();
    setCellValue(ws, 2, 0, "=SUM(B2:B3)", "csv");
    expect(ws.A3).toMatchObject({ t: "s", v: "=SUM(B2:B3)" });
  });

  it("日期序列号与显示格式保留", () => {
    const ws: XLSX.WorkSheet = {
      A1: { t: "n", v: 45000, z: "yyyy-mm-dd" },
      "!ref": "A1",
    };
    const wb: XLSX.WorkBook = { SheetNames: ["日期"], Sheets: { 日期: ws } };
    const parsed = parseSheet(toArrayBuffer(writeSheet(wb, "xlsx")), "xlsx");
    const cell = parsed.Sheets["日期"].A1;
    expect(cell.v).toBe(45000);
    expect(typeof cell.w).toBe("string");
    expect(cellRaw(parsed.Sheets["日期"], 0, 0)).toBe("45000");
  });

  it("超过行列上限直接拒绝", () => {
    const wb: XLSX.WorkBook = {
      SheetNames: ["大表"],
      Sheets: {
        大表: { "!ref": "A1:A5001" },
      },
    };
    expect(() => ensureSheetLimits(wb)).toThrow("5000 行");
  });
});

describe("Tiptap 校验与 docx 导出", () => {
  it("合法 JSON 通过；非法结构被拒", () => {
    expect(parseTiptapDoc({ type: "doc", content: [{ type: "paragraph" }] })).toMatchObject({
      type: "doc",
    });
    expect(() => parseTiptapDoc({ type: "paragraph" })).toThrow("格式不正确");
    expect(() => parseTiptapDoc(null)).toThrow("格式不正确");
  });

  it("过深嵌套被拒", () => {
    let node: Record<string, unknown> = { type: "paragraph" };
    for (let i = 0; i < 52; i++) node = { type: "blockquote", content: [node] };
    expect(() => parseTiptapDoc({ type: "doc", content: [node] })).toThrow("嵌套层级过深");
  });

  it("tiptapDocText 取纯文本", () => {
    const doc = parseTiptapDoc({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
        { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
      ],
    });
    expect(tiptapDocText(doc)).toBe("第一段第二段");
  });

  it("导出 docx 后 mammoth 能读回标题、正文与列表", async () => {
    const buffer = await exportTiptapToDocx({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "项目汇报" }],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "这是", marks: [{ type: "bold" }] },
            { type: "text", text: "正文" },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "要点一" }] },
              ],
            },
          ],
        },
      ],
    });
    expect(buffer.length).toBeGreaterThan(0);

    const { value } = await mammoth.convertToHtml({ buffer });
    expect(value).toContain("项目汇报");
    expect(value).toContain("这是");
    expect(value).toContain("正文");
    expect(value).toContain("要点一");
  });
});
