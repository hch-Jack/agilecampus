import { describe, expect, it } from "vitest";
import {
  GENERATE_MAX_CHARS,
  docxFromText,
  fileExtension,
  generateFile,
} from "@/lib/agent/file-generate";
import { extractFileText } from "@/lib/agent/file-text";

describe("助手生成文件：按扩展名编码", () => {
  it("文本类原样写入，MIME 按类型给", async () => {
    const md = await generateFile({ filename: "周报.md", content: "# 本周\n\n- 完成了 X" });
    expect(md.mimeType).toContain("text/markdown");
    expect(md.data.toString("utf8")).toBe("# 本周\n\n- 完成了 X");

    const json = await generateFile({
      filename: "data.json",
      content: '{"a":1}',
    });
    expect(json.mimeType).toContain("application/json");
    expect(json.data.toString("utf8")).toBe('{"a":1}');

    const py = await generateFile({ filename: "main.py", content: "print(1)" });
    expect(py.mimeType).toContain("python");
  });

  it("CSV 正文转成真正的 xlsx，能被正文抽取读回来", async () => {
    const out = await generateFile({
      filename: "成绩.xlsx",
      content: "姓名,分数\n张三,90\n李四,85",
      sheetName: "期中",
    });
    expect(out.mimeType).toContain("spreadsheetml");
    // SheetJS 写出的不是 zip 头也正常；这里直接走抽取链路验证内容
    const extracted = await extractFileText({
      filename: out.filename,
      mimeType: out.mimeType,
      data: out.data,
    });
    expect(extracted).toHaveProperty("text");
    const text = (extracted as { text: string }).text;
    expect(text).toContain("张三");
    expect(text).toContain("90");
    expect(text).toContain("期中");
  });

  it("纯文本转成 docx，mammoth 能抽回同样的行", async () => {
    const out = await generateFile({
      filename: "开题报告.docx",
      content: "第一章 研究背景\n\n已有研究 & 缺口",
    });
    expect(out.mimeType).toContain("wordprocessingml");
    const extracted = await extractFileText({
      filename: out.filename,
      mimeType: out.mimeType,
      data: out.data,
    });
    expect(extracted).toHaveProperty("text");
    const text = (extracted as { text: string }).text;
    expect(text).toContain("第一章 研究背景");
    expect(text).toContain("已有研究 & 缺口");
  });

  it("docx 生成器对 XML 特殊字符转义，不会把文档写坏", async () => {
    const zip = docxFromText('<w:p> & "引号"');
    expect(zip.length).toBeGreaterThan(100);
    const extracted = await extractFileText({
      filename: "x.docx",
      mimeType: null,
      data: zip,
    });
    expect((extracted as { text: string }).text).toContain('<w:p> & "引号"');
  });

  it("不支持的格式、缺扩展名、超长正文都明确拒绝", async () => {
    await expect(generateFile({ filename: "a.pdf", content: "x" })).rejects.toThrow(
      /暂不支持生成 \.pdf/,
    );
    await expect(generateFile({ filename: "README", content: "x" })).rejects.toThrow(
      "带扩展名",
    );
    await expect(
      generateFile({ filename: "a.txt", content: "x".repeat(GENERATE_MAX_CHARS + 1) }),
    ).rejects.toThrow("最多");
    await expect(generateFile({ filename: "a.txt", content: "" })).rejects.toThrow(
      "不能为空",
    );
    expect(fileExtension("归档.tar.gz")).toBe("gz");
  });
});
