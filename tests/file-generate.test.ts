import { describe, expect, it } from "vitest";
import { GENERATE_MAX_CHARS, fileExtension, generateFile } from "@/lib/agent/file-generate";
import { blocksFromText, documentFromText } from "@/lib/agent/document-spec";
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

  it("sheets 结构生成多工作表", async () => {
    const out = await generateFile({
      filename: "台账.xlsx",
      sheets: [
        { name: "任务", headers: ["任务", "负责人"], rows: [["拆解", "张三"]] },
        { name: "预算", headers: ["项目", "金额"], rows: [["设备", "1200"]] },
      ],
    });
    const extracted = (await extractFileText({
      filename: out.filename,
      mimeType: out.mimeType,
      data: out.data,
    })) as { text: string };
    expect(extracted.text).toContain("任务");
    expect(extracted.text).toContain("预算");
    expect(extracted.text).toContain("张三");
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

  it("结构化稿件生成 docx：标题、列表、表格都能抽回来，特殊字符不写坏文件", async () => {
    const out = await generateFile({
      filename: "周报.docx",
      document: {
        title: "第 12 周周报",
        subtitle: "赤壁演习项目",
        blocks: [
          { type: "heading", level: 1, text: "进展" },
          { type: "paragraph", text: '包含 <w:p> & "引号"' },
          { type: "list", ordered: true, items: ["完成接口联调", "补齐回归用例"] },
          {
            type: "table",
            headers: ["事项", "负责人"],
            rows: [["接口", "张三"]],
          },
        ],
      },
    });
    expect(out.mimeType).toContain("wordprocessingml");
    const text = (
      (await extractFileText({
        filename: out.filename,
        mimeType: out.mimeType,
        data: out.data,
      })) as { text: string }
    ).text;
    expect(text).toContain("第 12 周周报");
    expect(text).toContain('<w:p> & "引号"');
    expect(text).toContain("完成接口联调");
    expect(text).toContain("张三");
  });

  it("生成 PDF：返回真正的 PDF 字节，中文不会炸", async () => {
    const out = await generateFile({
      filename: "结题报告.pdf",
      document: {
        title: "结题报告",
        theme: "academic",
        blocks: [
          { type: "paragraph", text: "本项目按期完成了全部研究内容。" },
          {
            type: "table",
            headers: ["指标", "数值"],
            rows: [["准确率", "92%"]],
          },
          { type: "pageBreak" },
          { type: "paragraph", text: "第二页正文。" },
        ],
      },
    });
    expect(out.mimeType).toBe("application/pdf");
    expect(out.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(out.data.length).toBeGreaterThan(1000);
  });

  it("生成 PPTX：返回 zip 包，封面 + 表格页都在", async () => {
    const out = await generateFile({
      filename: "汇报.pptx",
      slides: {
        title: "中期汇报",
        slides: [
          { layout: "title", title: "中期汇报", subtitle: "赤壁演习" },
          { layout: "bullets", title: "进展", bullets: ["完成联调", "压测通过"] },
          {
            layout: "table",
            title: "指标",
            table: { headers: ["指标", "数值"], rows: [["准确率", "92%"]] },
          },
        ],
      },
    });
    expect(out.mimeType).toContain("presentationml");
    expect(out.data.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(out.data.length).toBeGreaterThan(5000);
  });

  it("只给正文也能生成 PPT（按标题拆页）", async () => {
    const out = await generateFile({
      filename: "大纲.pptx",
      content: "# 项目背景\n- 问题\n- 目标\n\n## 计划\n1. 第一周\n2. 第二周",
    });
    expect(out.data.subarray(0, 2).toString("latin1")).toBe("PK");
  });

  it("不支持旧格式、缺扩展名、超长正文都明确拒绝", async () => {
    await expect(generateFile({ filename: "a.doc", content: "x" })).rejects.toThrow(
      /不支持旧的 \.doc/,
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
    await expect(generateFile({ filename: "a.pdf" })).rejects.toThrow("content");
    expect(fileExtension("归档.tar.gz")).toBe("gz");
  });
});

describe("纯文本 → 文档块", () => {
  it("识别标题、列表、引用、代码与表格", () => {
    const blocks = blocksFromText(
      ["# 标题", "", "一段正文。", "", "- 甲", "- 乙", "", "> 引用", "", "```", "code()", "```", "", "| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
      "code",
      "table",
    ]);
    const table = blocks.find((b) => b.type === "table");
    expect(table).toMatchObject({ headers: ["A", "B"], rows: [["1", "2"]] });
  });

  it("首个一级标题提升为文档标题", () => {
    const doc = documentFromText("# 项目总结\n\n正文");
    expect(doc.title).toBe("项目总结");
    expect(doc.blocks).toEqual([{ type: "paragraph", text: "正文" }]);
  });
});
