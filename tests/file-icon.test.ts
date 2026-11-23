import { describe, it, expect } from "vitest";
import { FILE_ICON_LABELS, fileIconKind } from "@/lib/file-icon";

describe("fileIconKind", () => {
  it("图片 / PDF / 音视频 / Office 直接复用预览类别", () => {
    expect(fileIconKind("照片.JPG", null)).toBe("image");
    expect(fileIconKind("logo.svg", null)).toBe("image");
    expect(fileIconKind("报告.pdf", null)).toBe("pdf");
    expect(fileIconKind("录屏.mp4", null)).toBe("video");
    expect(fileIconKind("语音.mp3", null)).toBe("audio");
    expect(fileIconKind("方案.docx", null)).toBe("word");
    expect(fileIconKind("旧方案.doc", null)).toBe("doc");
    expect(fileIconKind("数据.xlsx", null)).toBe("excel");
    expect(fileIconKind("汇报.pptx", null)).toBe("ppt");
  });

  it("mimeType 优先于扩展名（与预览判定一致）", () => {
    expect(fileIconKind("没有扩展名", "image/png")).toBe("image");
    expect(fileIconKind("其实是pdf.md", "application/pdf")).toBe("pdf");
  });

  it("文本类按扩展名细分为 Markdown / 网页 / 数据配置 / 代码", () => {
    expect(fileIconKind("说明.md", null)).toBe("markdown");
    expect(fileIconKind("页面.html", null)).toBe("web");
    expect(fileIconKind("样式.scss", null)).toBe("web");
    expect(fileIconKind("配置.yml", null)).toBe("data");
    expect(fileIconKind("接口.json", null)).toBe("data");
    expect(fileIconKind("表格.csv", null)).toBe("data");
    expect(fileIconKind("笔记本.ipynb", null)).toBe("data");
    expect(fileIconKind("main.ts", null)).toBe("code");
    expect(fileIconKind("app.py", null)).toBe("code");
    expect(fileIconKind("Makefile", null)).toBe("code");
    expect(fileIconKind("CMakeLists.txt", null)).toBe("code");
  });

  it("无扩展名 / 点开头的常见文件不落入「其他」", () => {
    expect(fileIconKind("README", null)).toBe("text");
    expect(fileIconKind("LICENSE", null)).toBe("text");
    expect(fileIconKind(".gitignore", null)).toBe("data");
    expect(fileIconKind(".env.local", null)).toBe("data");
    expect(fileIconKind("Dockerfile", null)).toBe("code");
  });

  it("压缩包与真正无法识别的文件", () => {
    expect(fileIconKind("备份.zip", null)).toBe("archive");
    expect(fileIconKind("备份.tar.gz", null)).toBe("archive");
    expect(fileIconKind("未知.bin", null)).toBe("other");
  });

  it("每个分类都有中文标签", () => {
    for (const label of Object.values(FILE_ICON_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
