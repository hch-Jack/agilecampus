import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
import {
  resolveFontFamily,
  resolveTheme,
  type DocBlock,
  type DocTheme,
  type DocumentSpec,
} from "./document-spec";

/**
 * 结构化稿件 → Word（.docx）。
 *
 * 用 `docx` 包直接生成 OOXML：自定义标题样式、正文行距、表格斑马纹、引用条、代码块底色、
 * 页脚页码。中文正文用「微软雅黑」，行距 1.33，段后留白，打开就是排好的稿子，
 * 而不是原来那种「每行一段、全篇一个字号」的纯文本。
 */

/** A4 尺寸（twips）：210mm × 297mm —— 显式写进页面属性，不依赖库的默认值 */
const A4_WIDTH = 11906;
const A4_HEIGHT = 16838;

/** A4 版心宽度（twips）：11906 - 左右各 1440（2.54cm） */
const CONTENT_TWIPS = A4_WIDTH - 1440 * 2;

/**
 * 估算分页用的版面度量。
 *
 * Word 打开时会自己按页高排版，但**前端预览（docx-preview）只在显式分页符处换页**，
 * 不按内容高度自动切页 —— 没有分页符的稿子会显示成一条超级长的「页」。
 * 所以生成时按估算的行数主动切页：至少让每一章另起一页，内容够长时也会翻页。
 */
const PAGE_LINES = 38; // A4 版心约 42 行正文，留一点余量，避免和 Word 的实际分页错位太多
const CHARS_PER_LINE = 40; // 10.5pt 中文正文在 6.27 英寸版心里一行约 40 个字
const TABLE_ROWS_PER_PAGE = 20;

function textLines(text: string): number {
  return text
    .split("\n")
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
}

/** 每个块大约占多少行（用于判断当前页还放不放得下） */
function estimateLines(block: DocBlock): number {
  switch (block.type) {
    case "heading":
      return block.level === 1 ? 3 : block.level === 2 ? 2.2 : 1.8;
    case "paragraph":
      return textLines(block.text);
    case "list":
      return block.items.reduce((sum, item) => sum + textLines(item) + 0.4, 0) + 1;
    case "table":
      return (
        Math.min(block.rows.length + 1, TABLE_ROWS_PER_PAGE) * 1.15 +
        (block.caption ? 1 : 0) +
        1
      );
    case "quote":
      return textLines(block.text) + 0.8;
    case "code":
      return block.text.split("\n").length + 0.6;
    case "callout":
      return textLines(block.text) + (block.title ? 1 : 0) + 0.6;
    case "stats":
      return 3.5;
    case "banner":
      return 3.2 + (block.subtitle ? 1.2 : 0);
    case "cards": {
      // 每张卡只有版心的 1/cols 宽，同样的文字行数要乘以列数
      const cols = block.items.length;
      const lines = Math.max(
        ...block.items.map(
          (item) => textLines(item.title) * cols + textLines(item.text) * cols,
        ),
      );
      return Math.min(lines, PAGE_LINES - 6) + (block.title ? 1.6 : 0) + 1.6;
    }
    case "timeline":
      return (
        (block.title ? 1.6 : 0) +
        block.items.reduce((sum, item) => sum + textLines(item.text ?? item.title ?? "") + 1.4, 0)
      );
    case "progress":
      return (block.title ? 1.4 : 0) + block.items.length * 1.1 + 0.6;
    case "divider":
      return 1;
    case "pageBreak":
      return 0;
  }
}

function hex(value: string): string {
  return value.replace("#", "").toUpperCase();
}

function quoteBorders(theme: DocTheme) {
  return {
    left: { style: BorderStyle.SINGLE, size: 18, color: hex(theme.accent), space: 10 },
  };
}

function buildStyles(theme: DocTheme, bodyFont: string, headingFont: string) {
  const font = bodyFont;
  return {
    default: {
      document: {
        run: { font, size: 21, color: hex(theme.ink) },
        paragraph: { spacing: { line: 320, after: 120 } },
      },
    },
    paragraphStyles: [
      {
        id: "DocTitle",
        name: "Doc Title",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: headingFont, size: 44, bold: true, color: hex(theme.primary) },
        paragraph: {
          spacing: { before: 120, after: 80, line: 280 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 14,
              color: hex(theme.accent),
              space: 8,
            },
          },
        },
      },
      {
        id: "DocSubtitle",
        name: "Doc Subtitle",
        basedOn: "Normal",
        next: "Normal",
        run: { font: headingFont, size: 23, color: hex(theme.muted) },
        paragraph: { spacing: { after: 80, line: 300 } },
      },
      {
        id: "DocMeta",
        name: "Doc Meta",
        basedOn: "Normal",
        next: "Normal",
        run: { font, size: 18, color: hex(theme.muted) },
        paragraph: { spacing: { after: 280 } },
      },
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: headingFont, size: 32, bold: true, color: hex(theme.primary) },
        paragraph: {
          spacing: { before: 360, after: 140, line: 300 },
          border: {
            bottom: {
              style: BorderStyle.SINGLE,
              size: 6,
              color: hex(theme.accent),
              space: 4,
            },
          },
        },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: headingFont, size: 26, bold: true, color: hex(theme.ink) },
        paragraph: { spacing: { before: 280, after: 90, line: 300 } },
      },
      {
        id: "Heading3",
        name: "Heading 3",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: { font: headingFont, size: 22, bold: true, color: hex(theme.primary) },
        paragraph: { spacing: { before: 200, after: 70, line: 300 } },
      },
      {
        id: "DocBody",
        name: "Doc Body",
        basedOn: "Normal",
        next: "Normal",
        run: { font, size: 21, color: hex(theme.ink) },
        paragraph: {
          alignment: AlignmentType.JUSTIFIED,
          spacing: { after: 120, line: 330 },
        },
      },
      {
        id: "DocQuote",
        name: "Doc Quote",
        basedOn: "Normal",
        next: "Normal",
        run: { font, size: 20, italics: true, color: hex(theme.muted) },
        paragraph: {
          indent: { left: 360, right: 240 },
          spacing: { before: 120, after: 160, line: 320 },
          border: quoteBorders(theme),
        },
      },
      {
        id: "DocCode",
        name: "Doc Code",
        basedOn: "Normal",
        next: "Normal",
        run: { font: "Consolas", size: 17, color: hex(theme.ink) },
        paragraph: {
          shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) },
          spacing: { before: 0, after: 0, line: 260 },
          indent: { left: 160, right: 160 },
        },
      },
      {
        id: "DocCallout",
        name: "Doc Callout",
        basedOn: "Normal",
        next: "Normal",
        run: { font, size: 20, color: hex(theme.ink) },
        paragraph: {
          indent: { left: 200, right: 120 },
          spacing: { before: 120, after: 160, line: 320 },
        },
      },
    ],
  };
}

function headingParagraph(block: Extract<DocBlock, { type: "heading" }>): Paragraph {
  const style = block.level === 1 ? "Heading1" : block.level === 2 ? "Heading2" : "Heading3";
  return new Paragraph({ style, children: [new TextRun({ text: block.text })] });
}

function tableParagraph(text: string, opts: { bold?: boolean; size?: number; color?: string; align?: (typeof AlignmentType)[keyof typeof AlignmentType] }) {
  return new Paragraph({
    alignment: opts.align,
    spacing: { before: 0, after: 0, line: 260 },
    children: [
      new TextRun({
        text: text || " ",
        bold: opts.bold,
        size: opts.size ?? 18,
        ...(opts.color ? { color: hex(opts.color) } : {}),
      }),
    ],
  });
}

function tableBlock(block: Extract<DocBlock, { type: "table" }>, theme: DocTheme): (Paragraph | Table)[] {
  // 列宽按内容长度大致分配，给短列一个下限，避免「备注」列被挤成一条线
  const weights = block.headers.map((header, index) => {
    let weight = Math.max(4, header.length);
    for (const row of block.rows.slice(0, 40)) {
      weight = Math.max(weight, (row[index] ?? "").length * 0.8);
    }
    return Math.min(weight, 32);
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  const widths = weights.map((w) => Math.round((w / total) * CONTENT_TWIPS));
  const cellMargins = { top: 90, bottom: 90, left: 130, right: 130 };
  const borders = {
    top: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) },
    left: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) },
    right: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) },
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) },
    insideVertical: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line) },
  };

  const rows = [
    new TableRow({
      tableHeader: true,
      children: block.headers.map(
        (header) =>
          new TableCell({
            shading: {
              type: ShadingType.CLEAR,
              color: "auto",
              fill: hex(theme.primary),
            },
            margins: cellMargins,
            children: [
              tableParagraph(header, { bold: true, size: 18, color: theme.onPrimary }),
            ],
          }),
      ),
    }),
    ...block.rows.map(
      (row, index) =>
        new TableRow({
          children: row.map(
            (cell) =>
              new TableCell({
                shading:
                  index % 2 === 1
                    ? { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) }
                    : undefined,
                margins: cellMargins,
                children: [tableParagraph(cell, { size: 18, color: theme.ink })],
              }),
          ),
        }),
    ),
  ];

  const out: (Paragraph | Table)[] = [];
  if (block.caption) {
    out.push(
      new Paragraph({
        spacing: { before: 160, after: 80 },
        children: [
          new TextRun({ text: block.caption, bold: true, size: 18, color: hex(theme.muted) }),
        ],
      }),
    );
  }
  out.push(
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: widths,
      layout: TableLayoutType.FIXED,
      borders,
      rows,
    }),
  );
  out.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
  return out;
}

function statsTable(block: Extract<DocBlock, { type: "stats" }>, theme: DocTheme): Table {
  const cellBorders = {
    top: { style: BorderStyle.NONE, size: 0, color: "auto" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
    left: { style: BorderStyle.NONE, size: 0, color: "auto" },
    right: { style: BorderStyle.NONE, size: 0, color: "auto" },
  };
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    columnWidths: block.items.map(() => Math.round(CONTENT_TWIPS / block.items.length)),
    borders: cellBorders,
    rows: [
      new TableRow({
        children: block.items.map(
          (item, index) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) },
              margins: { top: 140, bottom: 140, left: 160, right: 160 },
              borders:
                index === 0
                  ? cellBorders
                  : {
                      ...cellBorders,
                      left: { style: BorderStyle.SINGLE, size: 8, color: "FFFFFF" },
                    },
              children: [
                new Paragraph({
                  spacing: { after: 20, line: 300 },
                  children: [
                    new TextRun({
                      text: item.value,
                      bold: true,
                      size: 36,
                      color: hex(theme.primary),
                    }),
                  ],
                }),
                new Paragraph({
                  spacing: { after: 0 },
                  children: [
                    new TextRun({ text: item.label, size: 18, color: hex(theme.muted) }),
                  ],
                }),
              ],
            }),
        ),
      }),
    ],
  });
}

const NO_BORDERS = {
  top: { style: BorderStyle.NONE, size: 0, color: "auto" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "auto" },
  left: { style: BorderStyle.NONE, size: 0, color: "auto" },
  right: { style: BorderStyle.NONE, size: 0, color: "auto" },
} as const;

/** 横幅：整行深色底 + 大字，用作章节分隔 / 重点提示 */
function bannerTable(block: Extract<DocBlock, { type: "banner" }>, theme: DocTheme): Table {
  const children: Paragraph[] = [
    new Paragraph({
      spacing: { after: block.subtitle ? 80 : 0, line: 300 },
      children: [
        new TextRun({ text: block.text, bold: true, size: 32, color: hex(theme.onPrimary) }),
      ],
    }),
  ];
  if (block.subtitle) {
    children.push(
      new Paragraph({
        spacing: { after: 0, line: 300 },
        children: [
          new TextRun({ text: block.subtitle, size: 20, color: hex(theme.soft) }),
        ],
      }),
    );
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    columnWidths: [CONTENT_TWIPS],
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.primary) },
            margins: { top: 220, bottom: 220, left: 260, right: 260 },
            children,
          }),
        ],
      }),
    ],
  });
}

/** 卡片组：2–4 张并排的浅底卡片（短标题 + 说明） */
function cardsTable(block: Extract<DocBlock, { type: "cards" }>, theme: DocTheme): Table {
  const count = block.items.length;
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    columnWidths: block.items.map(() => Math.round(CONTENT_TWIPS / count)),
    borders: NO_BORDERS,
    rows: [
      new TableRow({
        children: block.items.map(
          (item, index) =>
            new TableCell({
              shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) },
              margins: { top: 160, bottom: 160, left: 180, right: 180 },
              // 用「白色内边框」撑出卡片之间的间隙
              borders:
                index === 0
                  ? NO_BORDERS
                  : { ...NO_BORDERS, left: { style: BorderStyle.SINGLE, size: 24, color: "FFFFFF" } },
              children: [
                new Paragraph({
                  spacing: { after: 60, line: 280 },
                  children: [
                    new TextRun({
                      text: item.title,
                      bold: true,
                      size: 21,
                      color: hex(theme.primary),
                    }),
                  ],
                }),
                new Paragraph({
                  spacing: { after: 0, line: 300 },
                  children: [new TextRun({ text: item.text, size: 18, color: hex(theme.ink) })],
                }),
              ],
            }),
        ),
      }),
    ],
  });
}

/** 时间线：左侧时间点标签 + 右侧内容，靠主色左条串成一条线 */
function timelineTable(block: Extract<DocBlock, { type: "timeline" }>, theme: DocTheme): Table {
  const markerWidth = Math.round(CONTENT_TWIPS * 0.2);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    layout: TableLayoutType.FIXED,
    columnWidths: [markerWidth, CONTENT_TWIPS - markerWidth],
    borders: NO_BORDERS,
    rows: block.items.map(
      (item) =>
        new TableRow({
          children: [
            new TableCell({
              shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(theme.soft) },
              margins: { top: 120, bottom: 120, left: 160, right: 160 },
              borders: {
                ...NO_BORDERS,
                left: { style: BorderStyle.SINGLE, size: 24, color: hex(theme.accent) },
                bottom: { style: BorderStyle.SINGLE, size: 24, color: "FFFFFF" },
              },
              children: [
                new Paragraph({
                  spacing: { after: 0, line: 260 },
                  children: [
                    new TextRun({
                      text: item.marker,
                      bold: true,
                      size: 19,
                      color: hex(theme.primary),
                    }),
                  ],
                }),
              ],
            }),
            new TableCell({
              margins: { top: 120, bottom: 120, left: 200, right: 120 },
              borders: {
                ...NO_BORDERS,
                bottom: { style: BorderStyle.SINGLE, size: 24, color: "FFFFFF" },
              },
              children: [
                ...(item.title
                  ? [
                      new Paragraph({
                        spacing: { after: 40, line: 280 },
                        children: [
                          new TextRun({
                            text: item.title,
                            bold: true,
                            size: 20,
                            color: hex(theme.ink),
                          }),
                        ],
                      }),
                    ]
                  : []),
                new Paragraph({
                  spacing: { after: 0, line: 300 },
                  children: [
                    new TextRun({ text: item.text ?? " ", size: 18, color: hex(theme.muted) }),
                  ],
                }),
              ],
            }),
          ],
        }),
    ),
  });
}

/** 进度条：用方块字符画条，任何预览器 / Word / WPS 都能显示 */
function progressParagraphs(
  block: Extract<DocBlock, { type: "progress" }>,
  theme: DocTheme,
): Paragraph[] {
  const SEGMENTS = 20;
  return block.items.map((item) => {
    const filled = Math.round((item.value / 100) * SEGMENTS);
    return new Paragraph({
      spacing: { before: 60, after: 60, line: 300 },
      children: [
        new TextRun({ text: `${item.label}  `, size: 20, color: hex(theme.ink) }),
        new TextRun({ text: "█".repeat(filled), size: 22, color: hex(theme.accent) }),
        new TextRun({
          text: "░".repeat(SEGMENTS - filled),
          size: 22,
          color: hex(theme.line),
        }),
        new TextRun({
          text: `  ${item.value}%`,
          bold: true,
          size: 20,
          color: hex(theme.primary),
        }),
      ],
    });
  });
}

function calloutParagraph(block: Extract<DocBlock, { type: "callout" }>, theme: DocTheme): Paragraph {
  const tone = block.tone ?? "info";
  const bar =
    tone === "success" ? "10B981" : tone === "warning" ? "D97706" : theme.accent;
  const fill = tone === "success" ? "ECFDF5" : tone === "warning" ? "FFFBEB" : theme.soft;
  const children: TextRun[] = [];
  if (block.title) {
    children.push(
      new TextRun({ text: block.title, bold: true, size: 20, color: hex(theme.ink) }),
      new TextRun({ break: 1 }),
    );
  }
  children.push(new TextRun({ text: block.text, size: 20, color: hex(theme.ink) }));
  return new Paragraph({
    style: "DocCallout",
    shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(fill) },
    border: {
      left: { style: BorderStyle.SINGLE, size: 24, color: hex(bar), space: 10 },
    },
    children,
  });
}

function codeParagraphs(block: Extract<DocBlock, { type: "code" }>): Paragraph[] {
  return block.text.split("\n").map(
    (line, index, all) =>
      new Paragraph({
        style: "DocCode",
        spacing: {
          before: index === 0 ? 120 : 0,
          after: index === all.length - 1 ? 160 : 0,
        },
        children: [new TextRun({ text: line || " " })],
      }),
  );
}

export async function docxFromDocument(spec: DocumentSpec): Promise<Buffer> {
  const theme = resolveTheme(spec.theme);
  const bodyFont = resolveFontFamily(spec.font, theme.font);
  const headingFont = resolveFontFamily(spec.headingFont, bodyFont);
  const children: (Paragraph | Table)[] = [];

  if (spec.title) {
    children.push(new Paragraph({ style: "DocTitle", children: [new TextRun({ text: spec.title })] }));
  }
  if (spec.subtitle) {
    children.push(
      new Paragraph({ style: "DocSubtitle", children: [new TextRun({ text: spec.subtitle })] }),
    );
  }
  const meta = [spec.author, spec.date].filter(Boolean).join("  ·  ");
  if (meta) {
    children.push(new Paragraph({ style: "DocMeta", children: [new TextRun({ text: meta })] }));
  }

  // 估算当前页已用行数；标题区按 4 行算
  let used = spec.title ? 4 : 0;
  let hasContent = false;
  const pushPageBreak = () => {
    children.push(new Paragraph({ children: [new PageBreak()] }));
    used = 0;
  };

  for (const block of spec.blocks) {
    if (block.type === "pageBreak") {
      pushPageBreak();
      continue;
    }

    const lines = estimateLines(block);
    // 一级标题 = 新章节，另起一页（文档开头除外）；当前页放不下下一个块时也翻页
    const chapterStart = block.type === "heading" && block.level === 1 && hasContent && used > 0;
    const overflow = used > 0 && used + lines > PAGE_LINES;
    if (chapterStart || overflow) pushPageBreak();

    switch (block.type) {
      case "heading":
        children.push(headingParagraph(block));
        break;
      case "paragraph":
        children.push(
          new Paragraph({ style: "DocBody", children: [new TextRun({ text: block.text })] }),
        );
        break;
      case "list":
        block.items.forEach((item) => {
          children.push(
            new Paragraph(
              block.ordered
                ? {
                    numbering: { reference: "ac-ordered", level: 0 },
                    spacing: { after: 60, line: 320 },
                    children: [new TextRun({ text: item })],
                  }
                : {
                    bullet: { level: 0 },
                    spacing: { after: 60, line: 320 },
                    children: [new TextRun({ text: item })],
                  },
            ),
          );
        });
        children.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
        break;
      case "table": {
        // 数据行太多时按页切开、每页重复表头 —— 预览器不会自动给长表格翻页
        if (block.rows.length > TABLE_ROWS_PER_PAGE) {
          for (let start = 0; start < block.rows.length; start += TABLE_ROWS_PER_PAGE) {
            if (start > 0) pushPageBreak();
            children.push(
              ...tableBlock(
                {
                  ...block,
                  rows: block.rows.slice(start, start + TABLE_ROWS_PER_PAGE),
                  ...(start === 0 && block.caption ? { caption: block.caption } : { caption: undefined }),
                },
                theme,
              ),
            );
          }
          used = Math.min(block.rows.length, TABLE_ROWS_PER_PAGE) * 1.15 + 1;
          hasContent = true;
          continue;
        }
        children.push(...tableBlock(block, theme));
        break;
      }
      case "quote":
        children.push(
          new Paragraph({ style: "DocQuote", children: [new TextRun({ text: block.text })] }),
        );
        break;
      case "code":
        children.push(...codeParagraphs(block));
        break;
      case "callout":
        children.push(calloutParagraph(block, theme));
        break;
      case "stats":
        children.push(statsTable(block, theme));
        children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
        break;
      case "banner":
        children.push(bannerTable(block, theme));
        children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
        break;
      case "cards":
        if (block.title) {
          children.push(
            new Paragraph({
              spacing: { before: 80, after: 100 },
              children: [
                new TextRun({ text: block.title, bold: true, size: 20, color: hex(theme.muted) }),
              ],
            }),
          );
        }
        children.push(cardsTable(block, theme));
        children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
        break;
      case "timeline":
        if (block.title) {
          children.push(
            new Paragraph({
              spacing: { before: 80, after: 100 },
              children: [
                new TextRun({ text: block.title, bold: true, size: 20, color: hex(theme.muted) }),
              ],
            }),
          );
        }
        children.push(timelineTable(block, theme));
        children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
        break;
      case "progress":
        if (block.title) {
          children.push(
            new Paragraph({
              spacing: { before: 80, after: 80 },
              children: [
                new TextRun({ text: block.title, bold: true, size: 20, color: hex(theme.muted) }),
              ],
            }),
          );
        }
        children.push(...progressParagraphs(block, theme));
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case "divider":
        children.push(
          new Paragraph({
            spacing: { before: 120, after: 160 },
            border: {
              bottom: {
                style: BorderStyle.SINGLE,
                size: 6,
                color: hex(theme.line),
                space: 1,
              },
            },
            children: [],
          }),
        );
        break;
    }
    used += lines;
    hasContent = true;
  }

  const title = spec.title ?? "";
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 80 },
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, color: hex(theme.line), space: 6 },
        },
        children: [
          ...(title
            ? [new TextRun({ text: `${title}  ·  `, size: 16, color: hex(theme.muted) })]
            : []),
          new TextRun({ text: "第 ", size: 16, color: hex(theme.muted) }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: hex(theme.muted) }),
          new TextRun({ text: " 页 / 共 ", size: 16, color: hex(theme.muted) }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: hex(theme.muted) }),
          new TextRun({ text: " 页", size: 16, color: hex(theme.muted) }),
        ],
      }),
    ],
  });

  const doc = new Document({
    title: spec.title,
    subject: spec.subtitle,
    creator: spec.author ?? "AgileCampus AI 助手",
    styles: buildStyles(theme, bodyFont, headingFont),
    numbering: {
      config: [
        {
          reference: "ac-ordered",
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 480, hanging: 300 } } },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            // 最常见的模板：A4 纵向、四边 2.54cm 页边距
            size: { width: A4_WIDTH, height: A4_HEIGHT },
            margin: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 },
          },
        },
        footers: { default: footer },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
