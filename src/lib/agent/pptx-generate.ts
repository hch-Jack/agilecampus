import PptxGenJS from "pptxgenjs";
import { stripDanglingPptxOverrides } from "@/lib/pptx-sanitize";
import { resolveTheme, type DocTheme, type PresentationSpec, type SlideSpec } from "./document-spec";

/**
 * 结构化幻灯片 → PowerPoint（.pptx）。
 *
 * 用 pptxgenjs 生成原生 PPTX（文本框、形状、原生表格，不是图片贴图）：
 * 封面页 / 章节页 / 要点页 / 表格页 / 大字引用 / 数据卡片 / 结束页七种版式，
 * 统一 16:9、统一配色、统一页脚页码。字体用「微软雅黑」，中文在 Windows 上不会掉字。
 */

const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN_X = 0.62;
const CONTENT_W = SLIDE_W - MARGIN_X * 2;
const BODY_TOP = 1.5;
const BODY_BOTTOM = 5.05;

function hex(value: string): string {
  return value.replace("#", "").toUpperCase();
}

/** 把主色往白里调，作为深色底上的副标题色 */
function tint(hexColor: string, amount: number): string {
  const value = hexColor.replace("#", "");
  const parts = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
  const mixed = parts.map((c) => Math.round(c + (255 - c) * amount));
  return mixed.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function addTitleBar(slide: PptxGenJS.Slide, title: string | undefined, theme: DocTheme): void {
  if (title) {
    slide.addText(title, {
      x: MARGIN_X,
      y: 0.42,
      w: CONTENT_W,
      h: 0.7,
      fontFace: theme.font,
      fontSize: 24,
      bold: true,
      color: hex(theme.primary),
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });
  }
  slide.addShape("rect", {
    x: MARGIN_X,
    y: 1.18,
    w: 0.86,
    h: 0.055,
    fill: { color: hex(theme.accent) },
    line: { color: hex(theme.accent), width: 0 },
  });
}

function addFooter(slide: PptxGenJS.Slide, theme: DocTheme, pageNo: number): void {
  slide.addText(`${pageNo}`, {
    x: SLIDE_W - 1.0,
    y: SLIDE_H - 0.45,
    w: 0.45,
    h: 0.28,
    fontFace: theme.font,
    fontSize: 10,
    color: hex(theme.muted),
    align: "right",
    margin: 0,
  });
  slide.addShape("rect", {
    x: MARGIN_X,
    y: SLIDE_H - 0.22,
    w: 0.4,
    h: 0.035,
    fill: { color: hex(theme.line) },
    line: { color: hex(theme.line), width: 0 },
  });
}

function coverSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.primary) };
  // 右侧一条竖向强调条，避免整页死板
  s.addShape("rect", {
    x: SLIDE_W - 0.55,
    y: 0,
    w: 0.14,
    h: SLIDE_H,
    fill: { color: hex(theme.accent) },
    line: { color: hex(theme.accent), width: 0 },
  });
  s.addShape("rect", {
    x: 0.95,
    y: 1.15,
    w: 1.15,
    h: 0.07,
    fill: { color: hex(theme.accent) },
    line: { color: hex(theme.accent), width: 0 },
  });
  s.addText(slide.title ?? "", {
    x: 0.95,
    y: 1.45,
    w: SLIDE_W - 2.2,
    h: 1.5,
    fontFace: theme.font,
    fontSize: 36,
    bold: true,
    color: hex(theme.onPrimary),
    valign: "top",
    margin: 0,
    fit: "shrink",
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: 0.97,
      y: 3.0,
      w: SLIDE_W - 2.3,
      h: 1.0,
      fontFace: theme.font,
      fontSize: 15,
      color: tint(theme.primary, 0.72),
      valign: "top",
      margin: 0,
      fit: "shrink",
    });
  }
  const meta = [theme.label].filter(Boolean).join(" · ");
  s.addText(meta, {
    x: 0.97,
    y: SLIDE_H - 0.85,
    w: 4,
    h: 0.3,
    fontFace: theme.font,
    fontSize: 10,
    color: tint(theme.primary, 0.55),
    margin: 0,
  });
  return s;
}

function sectionSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.soft) };
  s.addShape("rect", {
    x: 0,
    y: 0,
    w: 0.16,
    h: SLIDE_H,
    fill: { color: hex(theme.primary) },
    line: { color: hex(theme.primary), width: 0 },
  });
  s.addText(slide.title ?? "", {
    x: 1.0,
    y: 1.9,
    w: SLIDE_W - 2.0,
    h: 1.2,
    fontFace: theme.font,
    fontSize: 30,
    bold: true,
    color: hex(theme.primary),
    valign: "middle",
    margin: 0,
    fit: "shrink",
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: 1.02,
      y: 3.1,
      w: SLIDE_W - 2.2,
      h: 0.6,
      fontFace: theme.font,
      fontSize: 14,
      color: hex(theme.muted),
      margin: 0,
      fit: "shrink",
    });
  }
  s.addShape("rect", {
    x: 1.02,
    y: 3.15,
    w: 1.0,
    h: 0.06,
    fill: { color: hex(theme.accent) },
    line: { color: hex(theme.accent), width: 0 },
  });
  return s;
}

function bulletsSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title, theme);
  const bullets = slide.bullets ?? [];
  if (bullets.length > 0) {
    // 要点越多字号越小，避免溢出页面；下限 14pt
    const size = Math.max(14, Math.min(22, Math.round(120 / Math.max(bullets.length, 4)) + 8));
    const items = bullets.map((text) => ({
      text,
      options: {
        bullet: { indent: 22 },
        breakLine: true,
        paraSpaceAfter: Math.max(6, Math.round(size / 3)),
      },
    }));
    s.addText(items, {
      x: MARGIN_X + 0.1,
      y: BODY_TOP,
      w: CONTENT_W - 0.2,
      h: BODY_BOTTOM - BODY_TOP,
      fontFace: theme.font,
      fontSize: size,
      color: hex(theme.ink),
      valign: "top",
      margin: 0,
      lineSpacingMultiple: 1.15,
      fit: "shrink",
    });
  }
  return s;
}

function tableSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "数据", theme);
  const table = slide.table;
  if (!table) return s;
  const weights = table.headers.map((header, index) => {
    let weight = Math.max(3, header.length);
    for (const row of table.rows) weight = Math.max(weight, (row[index] ?? "").length * 0.6);
    return Math.min(weight, 24);
  });
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  const colW = weights.map((w) => (w / weightSum) * CONTENT_W);
  const rows: PptxGenJS.TableRow[] = [
    table.headers.map((header) => ({
      text: header,
      options: {
        bold: true,
        color: hex(theme.onPrimary),
        fill: { color: hex(theme.primary) },
        fontFace: theme.font,
        fontSize: 12,
        align: "left" as const,
        valign: "middle" as const,
        margin: 6,
      },
    })),
    ...table.rows.map((row, index) =>
      row.map((cell) => ({
        text: cell,
        options: {
          color: hex(theme.ink),
          fill: { color: index % 2 === 1 ? hex(theme.soft) : "FFFFFF" },
          fontFace: theme.font,
          fontSize: table.rows.length > 8 ? 10 : 12,
          align: "left" as const,
          valign: "middle" as const,
          margin: 6,
        },
      })),
    ),
  ];
  s.addTable(rows, {
    x: MARGIN_X,
    y: BODY_TOP,
    w: CONTENT_W,
    colW,
    border: { type: "solid", pt: 0.5, color: hex(theme.line) },
    fontFace: theme.font,
    autoPage: false,
    rowH: table.rows.length > 8 ? 0.28 : 0.36,
    valign: "middle",
  });
  return s;
}

function quoteSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.primary) };
  s.addText("“", {
    x: 0.8,
    y: 0.55,
    w: 1.2,
    h: 1.2,
    fontFace: "Georgia",
    fontSize: 88,
    bold: true,
    color: hex(theme.accent),
    margin: 0,
  });
  s.addText(slide.quote ?? slide.title ?? "", {
    x: 1.0,
    y: 1.7,
    w: SLIDE_W - 2.2,
    h: 2.6,
    fontFace: theme.font,
    fontSize: 24,
    color: hex(theme.onPrimary),
    valign: "middle",
    align: "center",
    margin: 0,
    fit: "shrink",
    lineSpacingMultiple: 1.3,
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: 1.0,
      y: 4.3,
      w: SLIDE_W - 2.2,
      h: 0.4,
      fontFace: theme.font,
      fontSize: 12,
      color: tint(theme.primary, 0.6),
      align: "center",
      margin: 0,
    });
  }
  return s;
}

function statsSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "关键数据", theme);
  const stats = slide.stats ?? [];
  const gap = 0.24;
  const w = (CONTENT_W - gap * (stats.length - 1)) / Math.max(stats.length, 1);
  const h = 1.75;
  const y = 2.3;
  stats.forEach((item, index) => {
    const x = MARGIN_X + index * (w + gap);
    s.addShape("roundRect", {
      x,
      y,
      w,
      h,
      rectRadius: 0.08,
      fill: { color: hex(theme.soft) },
      line: { color: hex(theme.line), width: 0.5 },
    });
    s.addShape("rect", {
      x,
      y,
      w,
      h: 0.07,
      fill: { color: hex(theme.accent) },
      line: { color: hex(theme.accent), width: 0 },
    });
    s.addText(item.value, {
      x: x + 0.18,
      y: y + 0.32,
      w: w - 0.36,
      h: 0.8,
      fontFace: theme.font,
      fontSize: 30,
      bold: true,
      color: hex(theme.primary),
      margin: 0,
      fit: "shrink",
      valign: "middle",
    });
    s.addText(item.label, {
      x: x + 0.18,
      y: y + 1.18,
      w: w - 0.36,
      h: 0.4,
      fontFace: theme.font,
      fontSize: 12,
      color: hex(theme.muted),
      margin: 0,
      fit: "shrink",
      valign: "top",
    });
  });
  return s;
}

function closingSlide(pptx: PptxGenJS, slide: SlideSpec, theme: DocTheme): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.primary) };
  s.addText(slide.title ?? "谢谢", {
    x: 1.0,
    y: 1.8,
    w: SLIDE_W - 2.0,
    h: 1.3,
    fontFace: theme.font,
    fontSize: 40,
    bold: true,
    color: hex(theme.onPrimary),
    align: "center",
    valign: "middle",
    margin: 0,
  });
  if (slide.subtitle) {
    s.addText(slide.subtitle, {
      x: 1.0,
      y: 3.15,
      w: SLIDE_W - 2.0,
      h: 0.5,
      fontFace: theme.font,
      fontSize: 14,
      color: tint(theme.primary, 0.65),
      align: "center",
      margin: 0,
    });
  }
  s.addShape("rect", {
    x: SLIDE_W / 2 - 0.45,
    y: 2.95,
    w: 0.9,
    h: 0.06,
    fill: { color: hex(theme.accent) },
    line: { color: hex(theme.accent), width: 0 },
  });
  return s;
}

export async function pptxFromPresentation(spec: PresentationSpec): Promise<Buffer> {
  const theme = resolveTheme(spec.theme);
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = spec.author ?? "AgileCampus AI 助手";
  pptx.company = "AgileCampus";
  pptx.title = spec.title ?? "演示文稿";
  pptx.subject = spec.subtitle ?? "";
  pptx.theme = { headFontFace: theme.font, bodyFontFace: theme.font };

  let pageNo = 0;
  for (const slide of spec.slides) {
    const layout = slide.layout ?? (slide.table ? "table" : slide.stats ? "stats" : "bullets");
    let current: PptxGenJS.Slide;
    switch (layout) {
      case "title":
        current = coverSlide(pptx, slide, theme);
        break;
      case "section":
        current = sectionSlide(pptx, slide, theme);
        break;
      case "table":
        current = tableSlide(pptx, slide, theme);
        break;
      case "quote":
        current = quoteSlide(pptx, slide, theme);
        break;
      case "stats":
        current = statsSlide(pptx, slide, theme);
        break;
      case "closing":
        current = closingSlide(pptx, slide, theme);
        break;
      default:
        current = bulletsSlide(pptx, slide, theme);
        break;
    }
    pageNo += 1;
    if (layout !== "title") {
      addFooter(current, theme, pageNo);
      if (slide.notes) current.addNotes(slide.notes);
    }
  }

  if (pageNo === 0) {
    // 兜底：至少给一页，避免生出 0 页的残缺文件（预览器会黑屏）
    coverSlide(pptx, { layout: "title", title: spec.title ?? "演示文稿" }, theme);
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  // 修掉 pptxgenjs 多声明出来的 slideMaster 部件，否则前端预览解析不了
  return Buffer.from(await stripDanglingPptxOverrides(buf));
}
