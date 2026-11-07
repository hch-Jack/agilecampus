import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from "pdf-lib";
import {
  DOC_THEMES,
  resolveTheme,
  type DocBlock,
  type DocTheme,
  type DocumentSpec,
} from "./document-spec";

/**
 * 结构化稿件 → PDF。
 *
 * 用 pdf-lib 自己排版：pdf-lib 不依赖 Node 的 fs / 系统字体，Next 的 server bundle 能直接打包；
 * 中文字形来自 `@embedpdf/fonts-sc` 里的 Noto Sans Hans（OFL），嵌入时按需子集化，
 * 一页几百字的 PDF 通常只有几十 KB。字体文件固定在 node_modules 里，容器里不用装字体。
 *
 * 版式原则：A4、2cm 边距、标题层级清楚、表格斑马纹、页脚页码 —— 像一份能直接发出去的稿子。
 */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 62;
const MARGIN_BOTTOM = 62;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const BODY_SIZE = 10.5;
const BODY_LINE = 17.5;

type Fonts = { regular: PDFFont; bold: PDFFont };

let fontBytesPromise: Promise<{ regular: Buffer; bold: Buffer }> | null = null;

/**
 * 字体路径按项目根解析：dev / vitest / standalone（cwd = /app）都能命中。
 * standalone 产物需要把这两个文件 trace 进去，见 next.config.ts 的 outputFileTracingIncludes。
 */
function fontDir(): string {
  return path.join(process.cwd(), "node_modules", "@embedpdf", "fonts-sc", "fonts");
}

async function loadFontBytes(): Promise<{ regular: Buffer; bold: Buffer }> {
  if (!fontBytesPromise) {
    const dir = fontDir();
    fontBytesPromise = Promise.all([
      readFile(path.join(dir, "NotoSansHans-Regular.otf")),
      readFile(path.join(dir, "NotoSansHans-Bold.otf")),
    ])
      .then(([regular, bold]) => ({ regular, bold }))
      .catch((error: unknown) => {
        fontBytesPromise = null;
        throw error;
      });
  }
  return fontBytesPromise;
}

function hexToRgb(hex: string): RGB {
  const value = hex.replace("#", "");
  return rgb(
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255,
  );
}

const CJK_CHAR = /[⺀-鿿豈-﫿＀-￯　-〿]/;
const TOKEN_RE = new RegExp(
  `${CJK_CHAR.source}|[^\\s\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u3000-\\u303f]+|\\s+`,
  "g",
);

/** 按字/词切分：中文逐字断行，西文按单词断行 */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.replace(/\t/g, "  ").split("\n")) {
    if (!rawLine) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const token of rawLine.match(TOKEN_RE) ?? []) {
      if (!line && /^\s+$/.test(token)) continue;
      const candidate = line + token;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(line.trimEnd());
        line = token.trimStart();
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line.trimEnd());
  }
  return lines.length > 0 ? lines : [""];
}

/** 表格列宽：先按每列内容自然宽度占比分配，再给小列一个下限 */
function columnWidths(block: Extract<DocBlock, { type: "table" }>, font: PDFFont): number[] {
  const cols = block.headers.length;
  const pad = 14;
  const natural = block.headers.map((header, index) => {
    let width = font.widthOfTextAtSize(header, 9);
    for (const row of block.rows.slice(0, 80)) {
      width = Math.max(width, font.widthOfTextAtSize(row[index] ?? "", 9));
    }
    return Math.min(width, CONTENT_WIDTH * 0.4) + pad;
  });
  const total = natural.reduce((sum, w) => sum + w, 0);
  const scaled = natural.map((w) => (w / total) * CONTENT_WIDTH);
  const min = CONTENT_WIDTH / cols / 2;
  // 把低于下限的列抬到下限，从最宽的列匀出空间
  for (let i = 0; i < scaled.length; i++) {
    if (scaled[i] < min) {
      const deficit = min - scaled[i];
      const widest = scaled.indexOf(Math.max(...scaled));
      scaled[i] = min;
      scaled[widest] = Math.max(min, scaled[widest] - deficit);
    }
  }
  const sum = scaled.reduce((a, b) => a + b, 0);
  return scaled.map((w) => (w / sum) * CONTENT_WIDTH);
}

class PdfBuilder {
  private readonly doc: PDFDocument;
  private readonly regular: PDFFont;
  private readonly bold: PDFFont;
  private readonly theme: DocTheme;
  private readonly title: string;
  private pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;

  constructor(doc: PDFDocument, fonts: Fonts, theme: DocTheme, title: string) {
    this.doc = doc;
    this.regular = fonts.regular;
    this.bold = fonts.bold;
    this.theme = theme;
    this.title = title;
  }

  newPage(): void {
    this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    this.pages.push(this.page);
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }

  /** 剩余空间不够就翻页 */
  ensure(height: number): void {
    if (this.y - height < MARGIN_BOTTOM + 16) this.newPage();
  }

  private drawLine(
    text: string,
    x: number,
    y: number,
    size: number,
    font: PDFFont,
    color: string,
  ): void {
    if (!text) return;
    this.page.drawText(text, { x, y, size, font, color: hexToRgb(color) });
  }

  private writeLines(
    lines: string[],
    x: number,
    size: number,
    font: PDFFont,
    color: string,
    lineHeight: number,
  ): void {
    for (const line of lines) {
      this.y -= lineHeight;
      if (line) this.drawLine(line, x, this.y, size, font, color);
    }
  }

  frontMatter(spec: DocumentSpec): void {
    if (!spec.title) return;
    const titleLines = wrapText(spec.title, this.bold, 23, CONTENT_WIDTH);
    this.writeLines(titleLines, MARGIN_X, 23, this.bold, this.theme.primary, 30);
    this.page.drawRectangle({
      x: MARGIN_X,
      y: this.y - 7,
      width: 64,
      height: 3,
      color: hexToRgb(this.theme.accent),
    });
    this.y -= 16;
    if (spec.subtitle) {
      const lines = wrapText(spec.subtitle, this.regular, 11.5, CONTENT_WIDTH);
      this.writeLines(lines, MARGIN_X, 11.5, this.regular, this.theme.muted, 18);
      this.y -= 2;
    }
    const meta = [spec.author, spec.date].filter(Boolean).join("  ·  ");
    if (meta) {
      this.y -= 10;
      this.drawLine(meta, MARGIN_X, this.y, 9, this.regular, this.theme.muted);
    }
    this.y -= 16;
    this.page.drawRectangle({
      x: MARGIN_X,
      y: this.y,
      width: CONTENT_WIDTH,
      height: 1,
      color: hexToRgb(this.theme.line),
    });
    this.y -= 20;
  }

  heading(block: Extract<DocBlock, { type: "heading" }>): void {
    if (block.level === 1) {
      this.ensure(52);
      this.y -= 14;
      const lines = wrapText(block.text, this.bold, 15.5, CONTENT_WIDTH);
      this.writeLines(lines, MARGIN_X, 15.5, this.bold, this.theme.primary, 21);
      this.y -= 7;
      const lastWidth = Math.min(
        CONTENT_WIDTH,
        Math.max(...lines.map((l) => this.bold.widthOfTextAtSize(l, 15.5)), 48),
      );
      this.page.drawRectangle({
        x: MARGIN_X,
        y: this.y,
        width: lastWidth,
        height: 1.6,
        color: hexToRgb(this.theme.accent),
      });
      this.y -= 12;
      return;
    }
    const size = block.level === 2 ? 12.8 : 11.2;
    const lineHeight = size + 5;
    this.ensure(lineHeight + 22);
    this.y -= block.level === 2 ? 12 : 8;
    const lines = wrapText(block.text, this.bold, size, CONTENT_WIDTH);
    this.writeLines(lines, MARGIN_X, size, this.bold, this.theme.ink, lineHeight);
    this.y -= 6;
  }

  paragraph(text: string): void {
    const lines = wrapText(text, this.regular, BODY_SIZE, CONTENT_WIDTH);
    for (const line of lines) {
      this.ensure(BODY_LINE);
      this.y -= BODY_LINE;
      if (line) this.drawLine(line, MARGIN_X, this.y, BODY_SIZE, this.regular, this.theme.ink);
    }
    this.y -= 7;
  }

  quote(text: string): void {
    const lines = wrapText(text, this.regular, 10.2, CONTENT_WIDTH - 18);
    const height = lines.length * 16.5 + 10;
    this.ensure(height);
    const top = this.y;
    this.y -= 5;
    this.writeLines(lines, MARGIN_X + 16, 10.2, this.regular, this.theme.muted, 16.5);
    this.page.drawRectangle({
      x: MARGIN_X + 2,
      y: this.y - 3,
      width: 3,
      height: Math.max(16, top - 5 - this.y),
      color: hexToRgb(this.theme.accent),
    });
    this.y -= 12;
  }

  list(block: Extract<DocBlock, { type: "list" }>): void {
    const indent = 18;
    block.items.forEach((item, index) => {
      const marker = block.ordered ? `${index + 1}.` : "•";
      const lines = wrapText(item, this.regular, BODY_SIZE, CONTENT_WIDTH - indent);
      this.ensure(BODY_LINE * Math.min(lines.length, 4));
      const firstBaseline = this.y - BODY_LINE;
      this.drawLine(
        marker,
        MARGIN_X + 2,
        firstBaseline,
        BODY_SIZE,
        this.regular,
        block.ordered ? this.theme.muted : this.theme.accent,
      );
      this.writeLines(
        lines,
        MARGIN_X + indent,
        BODY_SIZE,
        this.regular,
        this.theme.ink,
        BODY_LINE,
      );
    });
    this.y -= 6;
  }

  code(block: Extract<DocBlock, { type: "code" }>): void {
    const pad = 9;
    const size = 8.8;
    const lineHeight = 13.5;
    const lines: string[] = [];
    for (const source of block.text.split("\n")) {
      const wrapped = wrapText(source, this.regular, size, CONTENT_WIDTH - pad * 2);
      lines.push(...wrapped);
    }
    // 逐段绘制：跨页时在新页重画底色
    let index = 0;
    while (index < lines.length) {
      const available = Math.floor((this.y - MARGIN_BOTTOM - 20) / lineHeight) - 2;
      const take = Math.max(2, Math.min(lines.length - index, available));
      const chunk = lines.slice(index, index + take);
      const boxHeight = chunk.length * lineHeight + pad * 2;
      this.ensure(boxHeight + 8);
      const top = this.y;
      this.page.drawRectangle({
        x: MARGIN_X,
        y: top - boxHeight,
        width: CONTENT_WIDTH,
        height: boxHeight,
        color: hexToRgb(this.theme.soft),
      });
      this.y = top - pad;
      this.writeLines(chunk, MARGIN_X + pad, size, this.regular, this.theme.ink, lineHeight);
      this.y -= pad + 10;
      index += take;
    }
  }

  callout(block: Extract<DocBlock, { type: "callout" }>): void {
    const tone = block.tone ?? "info";
    const bar =
      tone === "success" ? "10B981" : tone === "warning" ? "D97706" : this.theme.accent;
    const fill =
      tone === "success" ? "ECFDF5" : tone === "warning" ? "FFFBEB" : this.theme.soft;
    const titleLines = block.title
      ? wrapText(block.title, this.bold, 10.5, CONTENT_WIDTH - 30)
      : [];
    const textLines = wrapText(block.text, this.regular, 10, CONTENT_WIDTH - 30);
    const height = titleLines.length * 16 + textLines.length * 16 + 18;
    this.ensure(height + 8);
    const top = this.y;
    this.page.drawRectangle({
      x: MARGIN_X,
      y: top - height,
      width: CONTENT_WIDTH,
      height,
      color: hexToRgb(fill),
    });
    this.page.drawRectangle({
      x: MARGIN_X,
      y: top - height,
      width: 3.5,
      height,
      color: hexToRgb(bar),
    });
    this.y = top - 9;
    if (titleLines.length > 0) {
      this.writeLines(titleLines, MARGIN_X + 14, 10.5, this.bold, this.theme.ink, 16);
      this.y -= 2;
    }
    this.writeLines(textLines, MARGIN_X + 14, 10, this.regular, this.theme.ink, 16);
    this.y -= 12;
  }

  stats(block: Extract<DocBlock, { type: "stats" }>): void {
    const gap = 10;
    const count = block.items.length;
    const width = (CONTENT_WIDTH - gap * (count - 1)) / count;
    const height = 62;
    this.ensure(height + 12);
    const top = this.y;
    block.items.forEach((item, index) => {
      const x = MARGIN_X + index * (width + gap);
      this.page.drawRectangle({
        x,
        y: top - height,
        width,
        height,
        color: hexToRgb(this.theme.soft),
      });
      this.page.drawRectangle({
        x,
        y: top - height,
        width,
        height: 2.5,
        color: hexToRgb(this.theme.accent),
      });
      this.drawLine(item.value, x + 10, top - 34, 19, this.bold, this.theme.primary);
      const label = wrapText(item.label, this.regular, 8.8, width - 20)[0] ?? "";
      this.drawLine(label, x + 10, top - 50, 8.8, this.regular, this.theme.muted);
    });
    this.y = top - height - 14;
  }

  table(block: Extract<DocBlock, { type: "table" }>): void {
    const size = 9;
    const lineHeight = 13;
    const padX = 6;
    const padY = 5;
    const widths = columnWidths(block, this.regular);

    if (block.caption) {
      const caption = wrapText(block.caption, this.bold, 9.2, CONTENT_WIDTH)[0] ?? "";
      this.ensure(20);
      this.y -= 12;
      this.drawLine(caption, MARGIN_X, this.y, 9.2, this.bold, this.theme.muted);
    }

    const drawRow = (cells: string[], header: boolean, zebra: boolean): void => {
      const wrapped = cells.map((cell, index) =>
        wrapText(cell || " ", header ? this.bold : this.regular, size, widths[index] - padX * 2),
      );
      const height = Math.max(...wrapped.map((lines) => lines.length)) * lineHeight + padY * 2;
      this.ensure(height + 2);
      const top = this.y;
      const fill = header
        ? this.theme.primary
        : zebra
          ? this.theme.soft
          : this.theme.onPrimary;
      this.page.drawRectangle({
        x: MARGIN_X,
        y: top - height,
        width: CONTENT_WIDTH,
        height,
        color: hexToRgb(fill),
      });
      this.page.drawRectangle({
        x: MARGIN_X,
        y: top - height,
        width: CONTENT_WIDTH,
        height,
        borderColor: hexToRgb(this.theme.line),
        borderWidth: 0.6,
      });
      let x = MARGIN_X;
      for (let i = 0; i < wrapped.length; i++) {
        if (i > 0) {
          this.page.drawLine({
            start: { x, y: top },
            end: { x, y: top - height },
            thickness: 0.6,
            color: hexToRgb(this.theme.line),
          });
        }
        let baseline = top - padY - lineHeight;
        for (const line of wrapped[i]) {
          this.drawLine(
            line,
            x + padX,
            baseline,
            size,
            header ? this.bold : this.regular,
            header ? this.theme.onPrimary : this.theme.ink,
          );
          baseline -= lineHeight;
        }
        x += widths[i];
      }
      this.y = top - height;
    };

    this.ensure(60);
    drawRow(block.headers, true, false);
    block.rows.forEach((row, index) => drawRow(row, false, index % 2 === 1));
    this.y -= 10;
  }

  divider(): void {
    this.ensure(20);
    this.y -= 10;
    this.page.drawRectangle({
      x: MARGIN_X,
      y: this.y,
      width: CONTENT_WIDTH,
      height: 1,
      color: hexToRgb(this.theme.line),
    });
    this.y -= 10;
  }

  /** 页脚统一最后画：那时才知道总页数 */
  finish(): void {
    const total = this.pages.length;
    const title = this.title.length > 34 ? `${this.title.slice(0, 34)}…` : this.title;
    this.pages.forEach((page, index) => {
      const y = MARGIN_BOTTOM - 26;
      page.drawRectangle({
        x: MARGIN_X,
        y: y + 12,
        width: CONTENT_WIDTH,
        height: 0.8,
        color: hexToRgb(this.theme.line),
      });
      if (title) {
        page.drawText(title, {
          x: MARGIN_X,
          y,
          size: 8,
          font: this.regular,
          color: hexToRgb(this.theme.muted),
        });
      }
      const label = `第 ${index + 1} 页 / 共 ${total} 页`;
      const width = this.regular.widthOfTextAtSize(label, 8);
      page.drawText(label, {
        x: PAGE_WIDTH - MARGIN_X - width,
        y,
        size: 8,
        font: this.regular,
        color: hexToRgb(this.theme.muted),
      });
    });
  }

  render(blocks: DocBlock[]): void {
    for (const block of blocks) {
      switch (block.type) {
        case "heading":
          this.heading(block);
          break;
        case "paragraph":
          this.paragraph(block.text);
          break;
        case "list":
          this.list(block);
          break;
        case "table":
          this.table(block);
          break;
        case "quote":
          this.quote(block.text);
          break;
        case "code":
          this.code(block);
          break;
        case "callout":
          this.callout(block);
          break;
        case "stats":
          this.stats(block);
          break;
        case "divider":
          this.divider();
          break;
        case "pageBreak":
          this.newPage();
          break;
      }
    }
  }
}

export async function pdfFromDocument(spec: DocumentSpec): Promise<Buffer> {
  const theme = resolveTheme(spec.theme ?? DOC_THEMES.business.name);
  const bytes = await loadFontBytes();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(spec.title ?? "");
  doc.setSubject(spec.subtitle ?? "");
  if (spec.author) doc.setAuthor(spec.author);
  doc.setCreator("AgileCampus AI 助手");
  doc.setProducer("pdf-lib");

  const fonts: Fonts = {
    regular: await doc.embedFont(bytes.regular, { subset: true }),
    bold: await doc.embedFont(bytes.bold, { subset: true }),
  };

  const builder = new PdfBuilder(doc, fonts, theme, spec.title ?? "");
  builder.newPage();
  builder.frontMatter(spec);
  builder.render(spec.blocks);
  builder.finish();

  return Buffer.from(await doc.save());
}
