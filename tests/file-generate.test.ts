import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { GENERATE_MAX_CHARS, fileExtension, generateFile } from "@/lib/agent/file-generate";
import { blocksFromText, documentFromText, type DocBlock } from "@/lib/agent/document-spec";
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

  it("生成的 docx 是 A4，长稿会主动分页（预览器不按高度自动切页）", async () => {
    const blocks: DocBlock[] = [];
    for (let i = 1; i <= 3; i++) {
      blocks.push({ type: "heading", level: 1, text: `第 ${i} 章` });
      blocks.push({ type: "paragraph", text: "正文内容。".repeat(30) });
    }
    const out = await generateFile({ filename: "长稿.docx", document: { title: "长稿", blocks } });
    const zip = await JSZip.loadAsync(out.data);
    const xml = await zip.file("word/document.xml")!.async("string");
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"');
    // 3 个一级标题 = 3 章：第 1 章在文首，后两章各另起一页
    expect((xml.match(/<w:br w:type="page"\/>/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  it("结构化稿件能用横幅/卡片/时间线/进度条，并指定正文字体与标题字体", async () => {
    const out = await generateFile({
      filename: "丰富排版.docx",
      document: {
        title: "丰富排版",
        font: "simsun",
        headingFont: "kaiti",
        blocks: [
          { type: "banner", text: "第一部分 项目进展", subtitle: "截至 11 月" },
          {
            type: "cards",
            title: "三大重点",
            items: [
              { title: "进度", text: "按期推进" },
              { title: "质量", text: "回归全绿" },
            ],
          },
          {
            type: "timeline",
            title: "路线",
            items: [
              { marker: "3 月", title: "立项", text: "确定范围" },
              { marker: "6 月", title: "中期", text: "完成联调" },
            ],
          },
          {
            type: "progress",
            title: "完成度",
            items: [
              { label: "前端", value: 80 },
              { label: "后端", value: 45 },
            ],
          },
        ],
      },
    });
    const zip = await JSZip.loadAsync(out.data);
    // 字体写在样式表里：正文宋体、标题楷体
    const styles = await zip.file("word/styles.xml")!.async("string");
    expect(styles).toContain("SimSun");
    expect(styles).toContain("KaiTi");
    const text = (
      (await extractFileText({
        filename: out.filename,
        mimeType: out.mimeType,
        data: out.data,
      })) as { text: string }
    ).text;
    expect(text).toContain("第一部分 项目进展");
    expect(text).toContain("三大重点");
    expect(text).toContain("确定范围");
    expect(text).toContain("80%");
  });

  it("红头文件：标题居中变红、红色分隔线、段落对齐/缩进/变色都写进 docx", async () => {
    const out = await generateFile({
      filename: "通知.docx",
      document: {
        title: "关于进一步加强项目管理的通知",
        titleAlign: "center",
        titleColor: "C00000",
        blocks: [
          { type: "divider", color: "C00000", thickness: 2.5 },
          { type: "paragraph", text: "各部门：" },
          {
            type: "paragraph",
            text: "为进一步规范项目管理，现将有关事项通知如下。",
            indent: true,
          },
          { type: "heading", level: 2, text: "一、总体要求", align: "center", color: "C00000" },
          { type: "paragraph", text: "请遵照执行。", align: "right" },
        ],
      },
    });
    const zip = await JSZip.loadAsync(out.data);
    const xml = await zip.file("word/document.xml")!.async("string");
    // 标题居中、红色
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:jc w:val="right"/>');
    expect(xml).toContain('w:color w:val="C00000"');
    // 红色分隔线：2.5pt → 20（八分之一磅）
    expect(xml).toMatch(/<w:bottom[^>]*w:color="C00000"[^>]*w:sz="20"/);
    // 首行缩进两字
    expect(xml).toContain('<w:ind w:firstLine="420"/>');
  });

  it("PDF 也能排横幅、卡片、时间线与进度条（同一份稿件不掉内容）", async () => {
    const out = await generateFile({
      filename: "丰富排版.pdf",
      document: {
        title: "丰富排版",
        titleAlign: "center",
        titleColor: "C00000",
        blocks: [
          { type: "divider", color: "C00000", thickness: 2.5, style: "double" },
          { type: "banner", text: "项目进展", subtitle: "截至 11 月", align: "center" },
          {
            type: "cards",
            items: [
              { title: "进度", text: "按期推进" },
              { title: "质量", text: "回归全绿" },
            ],
          },
          {
            type: "timeline",
            items: [{ marker: "3 月", title: "立项" }, { marker: "6 月", title: "中期" }],
          },
          { type: "progress", items: [{ label: "前端", value: 80 }] },
          { type: "paragraph", text: "首行缩进两字的正文。", indent: true, align: "justify" },
          { type: "paragraph", text: "右对齐落款", align: "right", color: "C00000" },
        ],
      },
    });
    expect(out.data.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(out.data.length).toBeGreaterThan(1000);
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

  it("生成的 PPTX 没有悬空部件声明，前端预览器才能解析", async () => {
    const out = await generateFile({
      filename: "汇报.pptx",
      slides: {
        title: "汇报",
        slides: [
          { layout: "title", title: "汇报" },
          { layout: "bullets", title: "进展", bullets: ["一", "二"] },
          { layout: "closing", title: "谢谢" },
        ],
      },
    });
    const zip = await JSZip.loadAsync(out.data);
    const types = await zip.file("[Content_Types].xml")!.async("string");
    const parts = new Set(Object.keys(zip.files).map((name) => `/${name}`));
    const dangling = [...types.matchAll(/PartName="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((part) => !parts.has(part));
    // pptxgenjs 会为每张幻灯片多声明一份 slideMasterN.xml；不修掉预览器会 0 页
    expect(dangling).toEqual([]);
  });

  it("PPT 支持卡片组 / 时间线 / 左右对比 / 原生图表，并可用自定义字体", async () => {
    const out = await generateFile({
      filename: "丰富版式.pptx",
      slides: {
        title: "丰富版式",
        font: "dengxian",
        headingFont: "simhei",
        slides: [
          { layout: "title", title: "丰富版式" },
          {
            layout: "cards",
            title: "三大重点",
            cards: [
              { title: "进度", text: "按期推进" },
              { title: "质量", text: "回归全绿" },
              { title: "协作", text: "每周同步" },
            ],
          },
          {
            layout: "timeline",
            title: "路线",
            timeline: [
              { marker: "3 月", title: "立项", text: "确定范围" },
              { marker: "6 月", title: "中期", text: "完成联调" },
              { marker: "9 月", title: "验收", text: "结题答辩" },
            ],
          },
          {
            layout: "comparison",
            title: "现状与目标",
            comparison: {
              left: { title: "现状", bullets: ["手工统计"] },
              right: { title: "目标", bullets: ["自动汇总"] },
            },
          },
          {
            layout: "chart",
            title: "月度完成",
            chart: {
              kind: "bar",
              categories: ["一月", "二月"],
              series: [{ name: "完成数", values: [3, 5] }],
            },
          },
          { layout: "closing", title: "谢谢" },
        ],
      },
    });
    const zip = await JSZip.loadAsync(out.data);
    const slides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    );
    expect(slides).toHaveLength(6);
    // 图表是原生的图表部件，不是贴图
    const chartName = Object.keys(zip.files).find((name) => /^ppt\/charts\/chart\d+\.xml$/.test(name));
    expect(chartName).toBeTruthy();
    const chart = await zip.file(chartName!)!.async("string");
    expect(chart).toContain("一月");
    const cardSlide = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(cardSlide).toContain("三大重点");
    const timelineSlide = await zip.file("ppt/slides/slide3.xml")!.async("string");
    expect(timelineSlide).toContain("确定范围");
  });

  it("PPT 要点支持子项层级，可设置正文对齐与颜色", async () => {
    const out = await generateFile({
      filename: "子项.pptx",
      slides: {
        title: "子项",
        slides: [
          {
            layout: "bullets",
            title: "工作安排",
            align: "center",
            textColor: "1E3A5F",
            bullets: [
              "项目启动",
              { text: "组建团队", level: 1 },
              { text: "明确分工", level: 2 },
              "中期检查",
            ],
          },
        ],
      },
    });
    const zip = await JSZip.loadAsync(out.data);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("组建团队");
    expect(xml).toContain('lvl="1"');
    expect(xml).toContain('lvl="2"');
    expect(xml).toContain('algn="ctr"');
    expect(xml).toContain("1E3A5F");
    // 子项两个字不应作为正文出现
    expect(xml).not.toContain("子项：");
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
