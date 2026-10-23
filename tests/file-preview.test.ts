import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  TEXT_PREVIEW_MAX_BYTES,
  decodeTextWithFallback,
  detectPreviewKind,
  renderMimeFor,
} from "@/lib/file-preview";
import { excelToSheets } from "@/lib/file-preview-office";

describe("detectPreviewKind", () => {
  it("按 mimeType 优先判定（含大写与参数后缀）", () => {
    expect(detectPreviewKind("a", "image/png")).toBe("image");
    expect(detectPreviewKind("a", "Image/PNG")).toBe("image");
    expect(detectPreviewKind("a", "application/pdf")).toBe("pdf");
    expect(detectPreviewKind("a", "video/webm")).toBe("video");
    expect(detectPreviewKind("a", "audio/mpeg")).toBe("audio");
    expect(detectPreviewKind("a", "text/plain; charset=utf-8")).toBe("text");
    expect(detectPreviewKind("a", "application/geo+json")).toBe("text");
  });

  it("mimeType 缺失时按扩展名兜底（不区分大小写）", () => {
    expect(detectPreviewKind("照片.JPG", null)).toBe("image");
    expect(detectPreviewKind("报告.pdf", null)).toBe("pdf");
    expect(detectPreviewKind("录屏.mp4", null)).toBe("video");
    expect(detectPreviewKind("语音.mp3", null)).toBe("audio");
    expect(detectPreviewKind("笔记.txt", null)).toBe("text");
    expect(detectPreviewKind("代码.TSX", null)).toBe("text");
    expect(detectPreviewKind("schema.yml", null)).toBe("text");
  });

  it("可疑 mime 不越权改变判定：octet-stream 落扩展名，扩展名也不认识则不支持", () => {
    expect(detectPreviewKind("压缩包.zip", "application/octet-stream")).toBe("unsupported");
    expect(detectPreviewKind("无扩展名", null)).toBe("unsupported");
  });

  it("Office 新格式判定：docx→word，xlsx/xls/xlsm/xlsb→excel", () => {
    expect(detectPreviewKind("报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(
      "word",
    );
    expect(detectPreviewKind("报告.docx", null)).toBe("word");
    expect(detectPreviewKind("表格.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      "excel",
    );
    expect(detectPreviewKind("旧表.xls", "application/vnd.ms-excel")).toBe("excel");
    expect(detectPreviewKind("旧表.xls", null)).toBe("excel");
    expect(detectPreviewKind("宏表.xlsm", null)).toBe("excel");
    expect(detectPreviewKind("二进制.xlsb", null)).toBe("excel");
  });

  it("旧版二进制 .doc 无纯 JS 渲染方案，不支持预览", () => {
    expect(detectPreviewKind("老文档.doc", null)).toBe("unsupported");
    expect(detectPreviewKind("老文档.doc", "application/msword")).toBe("unsupported");
  });

  it("PPT 判定：pptx→ppt，旧版二进制 .ppt 不支持", () => {
    expect(detectPreviewKind("汇报.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation")).toBe(
      "ppt",
    );
    expect(detectPreviewKind("汇报.pptx", null)).toBe("ppt");
    expect(detectPreviewKind("老幻灯.ppt", null)).toBe("unsupported");
    expect(detectPreviewKind("老幻灯.ppt", "application/vnd.ms-powerpoint")).toBe("unsupported");
  });

  it("text/html 仍按文本源码预览（不内联渲染）", () => {
    expect(detectPreviewKind("index.html", "text/html")).toBe("text");
  });
});

describe("renderMimeFor", () => {
  it("PDF 恒为 application/pdf，音视频 mime 不准时按扩展名补正", () => {
    expect(renderMimeFor("报告.pdf", null)).toBe("application/pdf");
    expect(renderMimeFor("报告.pdf", "application/octet-stream")).toBe("application/pdf");
    expect(renderMimeFor("录屏.mp4", null)).toBe("video/mp4");
    expect(renderMimeFor("语音.m4a", "application/octet-stream")).toBe("audio/mp4");
    expect(renderMimeFor("语音.mp3", "audio/mpeg")).toBe("audio/mpeg");
  });

  it("图片/文本/不支持预览的格式无需补正 mime", () => {
    expect(renderMimeFor("图.png", "image/png")).toBeNull();
    expect(renderMimeFor("笔记.txt", "text/plain")).toBeNull();
    expect(renderMimeFor("压缩包.zip", null)).toBeNull();
  });

  it("音视频 mime 可用时原样信任；扩展名也不认识才返回 null（弹窗回落到下载提示）", () => {
    expect(renderMimeFor("影片.xyz", "video/whatever")).toBe("video/whatever");
    expect(renderMimeFor("影片.xyz", null)).toBeNull();
  });
});

describe("decodeTextWithFallback", () => {
  it("UTF-8 中文正常解码", () => {
    const bytes = new TextEncoder().encode("你好，世界");
    expect(decodeTextWithFallback(bytes.buffer as ArrayBuffer)).toBe("你好，世界");
  });

  it("GBK 字节探测为 GBK 而非乱码", () => {
    // GBK 编码的「你好」：C4 E3 BA C3（UTF-8 fatal 解不动，须落到 GBK）
    const bytes = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]);
    expect(decodeTextWithFallback(bytes.buffer as ArrayBuffer)).toBe("你好");
  });

  it("空缓冲返回空串，二进制乱序字节落到宽松解码不抛错", () => {
    expect(decodeTextWithFallback(new ArrayBuffer(0))).toBe("");
    const binary = new Uint8Array([0xff, 0xfe, 0x00, 0x81, 0x40]);
    expect(() => decodeTextWithFallback(binary.buffer as ArrayBuffer)).not.toThrow();
  });

  it("文本预览上限为 512KB", () => {
    expect(TEXT_PREVIEW_MAX_BYTES).toBe(512 * 1024);
  });
});

describe("excelToSheets（SheetJS 解析往返）", () => {
  // 用 SheetJS 现场生成 xlsx 字节，再走 excelToSheets 解析，验证解析链路与 HTML 输出形状
  function buildXlsx(sheets: { name: string; rows: unknown[][] }[]): ArrayBuffer {
    const wb = XLSX.utils.book_new();
    for (const s of sheets) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(s.rows), s.name);
    }
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
    return out;
  }

  it("多工作表逐表输出 <table>，单元格值正确", async () => {
    const buf = buildXlsx([
      { name: "明细", rows: [["任务", "工时"], ["开发", 8]] },
      { name: "汇总", rows: [["合计"], [8]] },
    ]);
    const sheets = await excelToSheets(buf);
    expect(sheets.map((s) => s.name)).toEqual(["明细", "汇总"]);
    expect(sheets[0].html).toContain("<table");
    expect(sheets[0].html).toContain("开发");
    expect(sheets[0].html).toContain("8");
    expect(sheets.every((s) => !s.truncated)).toBe(true);
  });

  it("超过 2000 行的工作表截断渲染", async () => {
    const rows: unknown[][] = [["序号"]];
    for (let i = 0; i < 2500; i++) rows.push([i]);
    const sheets = await excelToSheets(buildXlsx([{ name: "大表", rows }]));
    expect(sheets[0].truncated).toBe(true);
    // 2500 行数据不应整表渲染
    expect(sheets[0].html).not.toContain("2499");
  });
});
