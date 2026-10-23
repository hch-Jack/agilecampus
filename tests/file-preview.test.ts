import { describe, it, expect } from "vitest";
import {
  TEXT_PREVIEW_MAX_BYTES,
  decodeTextWithFallback,
  detectPreviewKind,
  renderMimeFor,
} from "@/lib/file-preview";

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
    expect(detectPreviewKind("文档.docx", null)).toBe("unsupported");
    expect(detectPreviewKind("表格.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe(
      "unsupported",
    );
    expect(detectPreviewKind("无扩展名", null)).toBe("unsupported");
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
