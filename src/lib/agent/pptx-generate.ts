import PptxGenJS from "pptxgenjs";
import { stripDanglingPptxOverrides } from "@/lib/pptx-sanitize";
import {
  resolveFontFamily,
  resolveTheme,
  type DocTheme,
  type PresentationSpec,
  type SlideSpec,
} from "./document-spec";

/**
 * 结构化幻灯片 → PowerPoint（.pptx）。
 *
 * 用 pptxgenjs 生成原生 PPTX（文本框、形状、原生表格、原生图表，不是图片贴图）：
 * 封面 / 章节 / 要点 / 表格 / 大字引用 / 数据卡片 / 卡片组 / 时间线 / 左右对比 / 图表 / 结束页，
 * 统一 16:9、统一配色、统一页脚页码。字体可在稿件里指定，默认「微软雅黑」。
 */

const SLIDE_W = 10;
const SLIDE_H = 5.625;
const MARGIN_X = 0.62;
const CONTENT_W = SLIDE_W - MARGIN_X * 2;
const BODY_TOP = 1.5;
const BODY_BOTTOM = 5.05;

/** 正文字体与标题字体（来自稿件里的 font / headingFont） */
type Fonts = { body: string; head: string };

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

function addTitleBar(
  slide: PptxGenJS.Slide,
  title: string | undefined,
  theme: DocTheme,
  fonts: Fonts,
): void {
  if (title) {
    slide.addText(title, {
      x: MARGIN_X,
      y: 0.42,
      w: CONTENT_W,
      h: 0.7,
      fontFace: fonts.head,
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

function addFooter(
  slide: PptxGenJS.Slide,
  theme: DocTheme,
  fonts: Fonts,
  pageNo: number,
): void {
  slide.addText(`${pageNo}`, {
    x: SLIDE_W - 1.0,
    y: SLIDE_H - 0.45,
    w: 0.45,
    h: 0.28,
    fontFace: fonts.body,
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

function coverSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.primary) };
  // 右下角的大圆：只做氛围，压在文字层下面
  s.addShape("ellipse", {
    x: 6.3,
    y: 2.45,
    w: 3.4,
    h: 3.4,
    fill: { color: tint(theme.primary, 0.16), transparency: 62 },
    line: { color: tint(theme.primary, 0.16), width: 0 },
  });
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
    fontFace: fonts.head,
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
      fontFace: fonts.body,
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
    fontFace: fonts.body,
    fontSize: 10,
    color: tint(theme.primary, 0.55),
    margin: 0,
  });
  return s;
}

function sectionSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.soft) };
  // 右上角的大圆环，和封面呼应（大半在页外，只留一道弧，不压正文）
  s.addShape("ellipse", {
    x: 8.15,
    y: -1.15,
    w: 2.9,
    h: 2.9,
    fill: { color: hex(theme.soft) },
    line: { color: tint(theme.primary, 0.55), width: 1.5 },
  });
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
    fontFace: fonts.head,
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
      fontFace: fonts.body,
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

function bulletsSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title, theme, fonts);
  // 字符串 = 顶层要点；{ text, level } = 带层级的子项
  const bullets = (slide.bullets ?? []).map((b) =>
    typeof b === "string"
      ? { text: b, level: 0 }
      : { text: b.text, level: Math.max(0, Math.min(2, b.level ?? 0)) },
  );
  if (bullets.length > 0) {
    // 要点越多字号越小，避免溢出页面；下限 13pt
    const size = Math.max(13, Math.min(22, Math.round(120 / Math.max(bullets.length, 4)) + 7));
    const subColor = slide.textColor ? tint(slide.textColor, 0.2) : hex(theme.muted);
    const items = bullets.map(({ text, level }) => ({
      text,
      options: {
        bullet: { indent: 22 + level * 16 },
        indentLevel: level,
        breakLine: true,
        paraSpaceAfter: Math.max(4, Math.round(size / (level > 0 ? 4 : 3))),
        ...(level > 0 ? { fontSize: Math.max(12, size - 2 * level), color: subColor } : {}),
      },
    }));
    s.addText(items, {
      x: MARGIN_X + 0.1,
      y: BODY_TOP,
      w: CONTENT_W - 0.2,
      h: BODY_BOTTOM - BODY_TOP,
      fontFace: fonts.body,
      fontSize: size,
      color: slide.textColor ? hex(slide.textColor) : hex(theme.ink),
      align: slide.align ?? "left",
      valign: "top",
      margin: 0,
      lineSpacingMultiple: 1.15,
      fit: "shrink",
    });
  }
  return s;
}

function tableSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "数据", theme, fonts);
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
        fontFace: fonts.body,
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
          fontFace: fonts.body,
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
    fontFace: fonts.body,
    autoPage: false,
    rowH: table.rows.length > 8 ? 0.28 : 0.36,
    valign: "middle",
  });
  return s;
}

function quoteSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
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
    fontFace: fonts.body,
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
      fontFace: fonts.body,
      fontSize: 12,
      color: tint(theme.primary, 0.6),
      align: "center",
      margin: 0,
    });
  }
  return s;
}

function statsSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "关键数据", theme, fonts);
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
      fontFace: fonts.body,
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
      fontFace: fonts.body,
      fontSize: 12,
      color: hex(theme.muted),
      margin: 0,
      fit: "shrink",
      valign: "top",
    });
  });
  return s;
}

function closingSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: hex(theme.primary) };
  // 背景的两个装饰圆
  s.addShape("ellipse", {
    x: -0.9,
    y: 3.3,
    w: 2.6,
    h: 2.6,
    fill: { color: tint(theme.primary, 0.16), transparency: 60 },
    line: { color: tint(theme.primary, 0.16), width: 0 },
  });
  s.addShape("ellipse", {
    x: 7.9,
    y: -0.9,
    w: 2.8,
    h: 2.8,
    fill: { color: tint(theme.primary, 0.16), transparency: 60 },
    line: { color: tint(theme.primary, 0.16), width: 0 },
  });
  s.addText(slide.title ?? "谢谢", {
    x: 1.0,
    y: 1.8,
    w: SLIDE_W - 2.0,
    h: 1.3,
    fontFace: fonts.head,
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
      fontFace: fonts.body,
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

/** 卡片组：2–4 张并排的圆角卡片，顶部色条区分层级 */
function cardsSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "重点", theme, fonts);
  const cards = slide.cards ?? [];
  if (cards.length === 0) return s;
  const gap = 0.22;
  const w = (CONTENT_W - gap * (cards.length - 1)) / cards.length;
  const y = 1.7;
  const h = 3.05;
  cards.forEach((card, index) => {
    const x = MARGIN_X + index * (w + gap);
    s.addShape("roundRect", {
      x,
      y,
      w,
      h,
      rectRadius: 0.06,
      fill: { color: hex(theme.soft) },
      line: { color: hex(theme.line), width: 0.5 },
    });
    s.addShape("rect", {
      x: x + 0.02,
      y,
      w: w - 0.04,
      h: 0.09,
      fill: { color: hex(index === 0 ? theme.primary : theme.accent) },
      line: { color: hex(index === 0 ? theme.primary : theme.accent), width: 0 },
    });
    s.addText(card.title, {
      x: x + 0.16,
      y: y + 0.24,
      w: w - 0.32,
      h: 0.62,
      fontFace: fonts.head,
      fontSize: 15,
      bold: true,
      color: hex(theme.primary),
      margin: 0,
      valign: "top",
      fit: "shrink",
    });
    s.addText(card.text, {
      x: x + 0.16,
      y: y + 0.92,
      w: w - 0.32,
      h: h - 1.08,
      fontFace: fonts.body,
      fontSize: 11.5,
      color: hex(theme.ink),
      margin: 0,
      valign: "top",
      fit: "shrink",
      lineSpacingMultiple: 1.2,
    });
  });
  return s;
}

/** 时间线：横向一条轴线 + 圆点，节点上下分别是时间标签和内容 */
function timelineSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "时间线", theme, fonts);
  const items = slide.timeline ?? [];
  if (items.length === 0) return s;
  const step = CONTENT_W / items.length;
  const lineY = 2.42;
  s.addShape("rect", {
    x: MARGIN_X + step / 2,
    y: lineY - 0.02,
    w: CONTENT_W - step,
    h: 0.04,
    fill: { color: hex(theme.line) },
    line: { color: hex(theme.line), width: 0 },
  });
  items.forEach((item, index) => {
    const cx = MARGIN_X + step * (index + 0.5);
    s.addShape("ellipse", {
      x: cx - 0.1,
      y: lineY - 0.1,
      w: 0.2,
      h: 0.2,
      fill: { color: hex(index === 0 ? theme.accent : theme.primary) },
      line: { color: "FFFFFF", width: 2 },
    });
    s.addText(item.marker, {
      x: cx - step / 2 + 0.05,
      y: 1.6,
      w: step - 0.1,
      h: 0.68,
      fontFace: fonts.head,
      fontSize: items.length > 5 ? 11 : 12.5,
      bold: true,
      color: hex(index === 0 ? theme.accent : theme.primary),
      align: "center",
      valign: "bottom",
      margin: 0,
      fit: "shrink",
    });
    if (item.title) {
      s.addText(item.title, {
        x: cx - step / 2 + 0.05,
        y: 2.62,
        w: step - 0.1,
        h: 0.62,
        fontFace: fonts.head,
        fontSize: items.length > 5 ? 10.5 : 12,
        bold: true,
        color: hex(theme.ink),
        align: "center",
        valign: "top",
        margin: 0,
        fit: "shrink",
      });
    }
    if (item.text) {
      s.addText(item.text, {
        x: cx - step / 2 + 0.05,
        y: item.title ? 3.22 : 2.62,
        w: step - 0.1,
        h: item.title ? 1.55 : 2.15,
        fontFace: fonts.body,
        fontSize: items.length > 5 ? 9.5 : 11,
        color: hex(theme.muted),
        align: "center",
        valign: "top",
        margin: 0,
        fit: "shrink",
        lineSpacingMultiple: 1.2,
      });
    }
  });
  return s;
}

/** 左右对比：两块并排面板，左主色 / 右强调色 */
function comparisonSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "对比", theme, fonts);
  const comparison = slide.comparison;
  if (!comparison) return s;
  const gap = 0.32;
  const w = (CONTENT_W - gap) / 2;
  const y = 1.62;
  const h = 3.15;
  const panels = [
    { side: comparison.left, color: theme.primary },
    { side: comparison.right, color: theme.accent },
  ];
  panels.forEach(({ side, color }, index) => {
    const x = MARGIN_X + index * (w + gap);
    s.addShape("roundRect", {
      x,
      y,
      w,
      h,
      rectRadius: 0.06,
      fill: { color: hex(theme.soft) },
      line: { color: hex(theme.line), width: 0.5 },
    });
    s.addShape("rect", {
      x: x + 0.02,
      y: y + 0.02,
      w: w - 0.04,
      h: 0.5,
      fill: { color: hex(color) },
      line: { color: hex(color), width: 0 },
    });
    s.addText(side.title, {
      x: x + 0.18,
      y: y + 0.02,
      w: w - 0.36,
      h: 0.5,
      fontFace: fonts.head,
      fontSize: 15,
      bold: true,
      color: hex(theme.onPrimary),
      valign: "middle",
      margin: 0,
      fit: "shrink",
    });
    if (side.bullets.length > 0) {
      s.addText(
        side.bullets.map((text) => ({
          text,
          options: { bullet: { indent: 16 }, breakLine: true, paraSpaceAfter: 6 },
        })),
        {
          x: x + 0.18,
          y: y + 0.66,
          w: w - 0.36,
          h: h - 0.8,
          fontFace: fonts.body,
          fontSize: 12,
          color: hex(theme.ink),
          valign: "top",
          margin: 0,
          fit: "shrink",
          lineSpacingMultiple: 1.15,
        },
      );
    }
  });
  return s;
}

/** 原生图表页：柱状 / 折线 / 饼图 / 环形图 */
function chartSlide(
  pptx: PptxGenJS,
  slide: SlideSpec,
  theme: DocTheme,
  fonts: Fonts,
): PptxGenJS.Slide {
  const s = pptx.addSlide();
  s.background = { color: "FFFFFF" };
  addTitleBar(s, slide.title ?? "数据图表", theme, fonts);
  const chart = slide.chart;
  if (!chart) return s;
  const typeMap = {
    bar: pptx.ChartType.bar,
    line: pptx.ChartType.line,
    pie: pptx.ChartType.pie,
    doughnut: pptx.ChartType.doughnut,
  } as const;
  const isPie = chart.kind === "pie" || chart.kind === "doughnut";
  // 饼 / 环形图一次只能表达一组数据，多系列留给柱状 / 折线
  const series = isPie ? chart.series.slice(0, 1) : chart.series;
  const data = series.map((item) => ({
    name: item.name,
    labels: chart.categories,
    values: chart.categories.map((_, index) => item.values[index] ?? 0),
  }));
  const colors = [
    theme.primary,
    theme.accent,
    tint(theme.primary, 0.45),
    tint(theme.accent, 0.45),
  ].map(hex);
  s.addChart(typeMap[chart.kind], data, {
    x: MARGIN_X,
    y: 1.62,
    w: CONTENT_W,
    h: 3.2,
    chartColors: colors,
    showLegend: isPie || series.length > 1,
    legendPos: "b",
    showPercent: isPie,
    showValue: chart.kind === "bar",
    barDir: "col",
    catAxisLabelColor: hex(theme.muted),
    valAxisLabelColor: hex(theme.muted),
    ...(chart.kind === "doughnut" ? { holeSize: 55 } : {}),
  });
  return s;
}

export async function pptxFromPresentation(spec: PresentationSpec): Promise<Buffer> {
  const theme = resolveTheme(spec.theme);
  const bodyFont = resolveFontFamily(spec.font, theme.font);
  const fonts: Fonts = {
    body: bodyFont,
    head: resolveFontFamily(spec.headingFont, bodyFont),
  };
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = spec.author ?? "AgileCampus AI 助手";
  pptx.company = "AgileCampus";
  pptx.title = spec.title ?? "演示文稿";
  pptx.subject = spec.subtitle ?? "";
  pptx.theme = { headFontFace: fonts.head, bodyFontFace: fonts.body };

  let pageNo = 0;
  for (const slide of spec.slides) {
    const layout =
      slide.layout ??
      (slide.table
        ? "table"
        : slide.stats
          ? "stats"
          : slide.cards
            ? "cards"
            : slide.timeline
              ? "timeline"
              : slide.comparison
                ? "comparison"
                : slide.chart
                  ? "chart"
                  : "bullets");
    let current: PptxGenJS.Slide;
    switch (layout) {
      case "title":
        current = coverSlide(pptx, slide, theme, fonts);
        break;
      case "section":
        current = sectionSlide(pptx, slide, theme, fonts);
        break;
      case "table":
        current = tableSlide(pptx, slide, theme, fonts);
        break;
      case "quote":
        current = quoteSlide(pptx, slide, theme, fonts);
        break;
      case "stats":
        current = statsSlide(pptx, slide, theme, fonts);
        break;
      case "cards":
        current = cardsSlide(pptx, slide, theme, fonts);
        break;
      case "timeline":
        current = timelineSlide(pptx, slide, theme, fonts);
        break;
      case "comparison":
        current = comparisonSlide(pptx, slide, theme, fonts);
        break;
      case "chart":
        current = chartSlide(pptx, slide, theme, fonts);
        break;
      case "closing":
        current = closingSlide(pptx, slide, theme, fonts);
        break;
      default:
        current = bulletsSlide(pptx, slide, theme, fonts);
        break;
    }
    pageNo += 1;
    if (layout !== "title") {
      addFooter(current, theme, fonts, pageNo);
      if (slide.notes) current.addNotes(slide.notes);
    }
  }

  if (pageNo === 0) {
    // 兜底：至少给一页，避免生出 0 页的残缺文件（预览器会黑屏）
    coverSlide(pptx, { layout: "title", title: spec.title ?? "演示文稿" }, theme, fonts);
  }

  const out = await pptx.write({ outputType: "nodebuffer" });
  const buf = Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
  // 修掉 pptxgenjs 多声明出来的 slideMaster 部件，否则前端预览解析不了
  return Buffer.from(await stripDanglingPptxOverrides(buf));
}
