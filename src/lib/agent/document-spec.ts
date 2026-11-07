import { z } from "zod";

/**
 * 助手生成「有排版的文档」时的结构化中间格式。
 *
 * 模型不再只给一段纯文本，而是给一份**带结构的稿件**：标题、章节、段落、列表、表格、
 * 引用、代码、分页……各输出器（docx / pdf / pptx / xlsx）再各自翻译成原生版式。
 * 这样同一份内容能落到不同格式里都保持「像一份文档」，而不是一坨等宽文字。
 *
 * 本模块是纯数据 + 校验 + 文本兜底解析，不 import 任何服务端依赖，可在测试里直接跑。
 *
 * 兼容旧调用：只给 `content` 时用 `blocksFromText()` 把 Markdown 风格文本解析成块，
 * 仍然比原来的「每行一段」好看。
 */

// —— 主题 ——

export const DOC_THEME_NAMES = ["business", "academic", "fresh", "minimal"] as const;
export type DocThemeName = (typeof DOC_THEME_NAMES)[number];

export type DocTheme = {
  name: DocThemeName;
  label: string;
  /** 主色：标题、表头、强调块（6 位 hex，不带 #） */
  primary: string;
  /** 辅助色：分隔线、引用条、次级强调 */
  accent: string;
  /** 正文色 */
  ink: string;
  /** 次要文字（说明、页脚） */
  muted: string;
  /** 边框 / 分隔线 */
  line: string;
  /** 浅底（斑马纹、卡片、代码块） */
  soft: string;
  /** 表头文字色（一般是白） */
  onPrimary: string;
  /** 正文与标题字体族（Word/PPT 用；PDF 固定用嵌入字体） */
  font: string;
};

export const DOC_THEMES: Record<DocThemeName, DocTheme> = {
  business: {
    name: "business",
    label: "商务蓝",
    primary: "1E3A5F",
    accent: "2F80ED",
    ink: "1F2937",
    muted: "6B7280",
    line: "D8E1EB",
    soft: "EEF4FA",
    onPrimary: "FFFFFF",
    font: "Microsoft YaHei",
  },
  academic: {
    name: "academic",
    label: "学术棕",
    primary: "6B1D2B",
    accent: "B45309",
    ink: "2A2118",
    muted: "7C6F63",
    line: "E3DAD0",
    soft: "F8F3EC",
    onPrimary: "FFFFFF",
    font: "Microsoft YaHei",
  },
  fresh: {
    name: "fresh",
    label: "清新绿",
    primary: "0F5E52",
    accent: "14B8A6",
    ink: "1F2A2E",
    muted: "5F7273",
    line: "D6E5E2",
    soft: "ECF7F4",
    onPrimary: "FFFFFF",
    font: "Microsoft YaHei",
  },
  minimal: {
    name: "minimal",
    label: "极简灰",
    primary: "111827",
    accent: "6B7280",
    ink: "1F2937",
    muted: "6B7280",
    line: "E5E7EB",
    soft: "F6F7F9",
    onPrimary: "FFFFFF",
    font: "Microsoft YaHei",
  },
};

export function resolveTheme(name?: string | null): DocTheme {
  if (name && (DOC_THEME_NAMES as readonly string[]).includes(name)) {
    return DOC_THEMES[name as DocThemeName];
  }
  return DOC_THEMES.business;
}

// —— 上限（模型给的稿子不可信，生成前一律夹紧） ——

export const DOC_MAX_BLOCKS = 300;
export const DOC_MAX_BLOCK_TEXT = 20_000;
export const DOC_MAX_TABLE_ROWS = 2_000;
export const DOC_MAX_COLS = 15;
export const DOC_MAX_SLIDES = 80;
export const DOC_MAX_SHEETS = 20;
export const DOC_MAX_SHEET_ROWS = 20_000;
export const DOC_MAX_SHEET_COLS = 50;

// —— 块 ——

const headingSchema = z.object({
  type: z.literal("heading"),
  level: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .default(1)
    .describe("1=章标题，2=节标题，3=小节标题"),
  text: z.string().min(1).max(300),
});

const paragraphSchema = z.object({
  type: z.literal("paragraph"),
  text: z.string().min(1).max(DOC_MAX_BLOCK_TEXT),
});

const listSchema = z.object({
  type: z.literal("list"),
  ordered: z.boolean().optional().describe("true=有序列表，默认无序"),
  items: z.array(z.string().min(1).max(2_000)).min(1).max(200),
});

const tableSchema = z.object({
  type: z.literal("table"),
  headers: z.array(z.string().max(200)).min(1).max(DOC_MAX_COLS),
  rows: z
    .array(z.array(z.string().max(2_000)).min(1).max(DOC_MAX_COLS))
    .min(1)
    .max(DOC_MAX_TABLE_ROWS),
  caption: z.string().max(300).optional().describe("表题，放在表格上方"),
});

const quoteSchema = z.object({
  type: z.literal("quote"),
  text: z.string().min(1).max(DOC_MAX_BLOCK_TEXT),
});

const codeSchema = z.object({
  type: z.literal("code"),
  text: z.string().min(1).max(DOC_MAX_BLOCK_TEXT),
  language: z.string().max(40).optional().describe("语言名，仅作标签"),
});

const dividerSchema = z.object({ type: z.literal("divider") });

const pageBreakSchema = z.object({ type: z.literal("pageBreak") });

const calloutSchema = z.object({
  type: z.literal("callout"),
  tone: z.enum(["info", "success", "warning"]).optional().describe("默认 info"),
  title: z.string().max(200).optional(),
  text: z.string().min(1).max(DOC_MAX_BLOCK_TEXT),
});

const statsSchema = z.object({
  type: z.literal("stats"),
  items: z
    .array(
      z.object({
        label: z.string().min(1).max(60),
        value: z.string().min(1).max(40),
      }),
    )
    .min(1)
    .max(4),
});

export const docBlockSchema = z.discriminatedUnion("type", [
  headingSchema,
  paragraphSchema,
  listSchema,
  tableSchema,
  quoteSchema,
  codeSchema,
  dividerSchema,
  pageBreakSchema,
  calloutSchema,
  statsSchema,
]);

export type DocBlock = z.infer<typeof docBlockSchema>;

export const documentSpecSchema = z.object({
  title: z.string().max(200).optional().describe("文档标题（不要和第一段标题重复）"),
  subtitle: z.string().max(400).optional().describe("副标题 / 一句话摘要"),
  author: z.string().max(120).optional().describe("作者或团队"),
  date: z.string().max(60).optional().describe("日期文案，如 2026-11-08"),
  theme: z.enum(DOC_THEME_NAMES).optional().describe("配色主题，默认 business"),
  blocks: z.array(docBlockSchema).min(1).max(DOC_MAX_BLOCKS),
});

export type DocumentSpec = z.infer<typeof documentSpecSchema>;

// —— 幻灯片 ——

export const slideSpecSchema = z.object({
  layout: z
    .enum(["title", "section", "bullets", "table", "quote", "stats", "closing"])
    .optional()
    .describe(
      "版式：title=封面，section=章节页，bullets=要点页（默认），table=表格页，quote=大字引用，stats=数据卡片，closing=结束页",
    ),
  title: z.string().max(200).optional(),
  subtitle: z.string().max(400).optional().describe("仅 title / section 页使用"),
  bullets: z
    .array(z.string().max(500))
    .max(12)
    .optional()
    .describe("要点，一条一行；可用「子项：…… 」不多于 12 条"),
  table: z
    .object({
      headers: z.array(z.string().max(200)).min(1).max(8),
      rows: z
        .array(z.array(z.string().max(500)).min(1).max(8))
        .min(1)
        .max(20),
    })
    .optional(),
  quote: z.string().max(500).optional(),
  stats: z
    .array(
      z.object({
        label: z.string().min(1).max(40),
        value: z.string().min(1).max(24),
      }),
    )
    .min(1)
    .max(4)
    .optional(),
  notes: z.string().max(2_000).optional().describe("演讲者备注"),
});

export type SlideSpec = z.infer<typeof slideSpecSchema>;

export const presentationSpecSchema = z.object({
  title: z.string().max(200).optional(),
  subtitle: z.string().max(300).optional(),
  author: z.string().max(120).optional(),
  date: z.string().max(60).optional(),
  theme: z.enum(DOC_THEME_NAMES).optional(),
  slides: z.array(slideSpecSchema).min(1).max(DOC_MAX_SLIDES),
});

export type PresentationSpec = z.infer<typeof presentationSpecSchema>;

// —— 表格（xlsx） ——

export const sheetSpecSchema = z.object({
  name: z.string().max(31).optional().describe("工作表名，默认 Sheet1、Sheet2…"),
  headers: z.array(z.string().max(200)).max(DOC_MAX_SHEET_COLS).optional(),
  rows: z
    .array(z.array(z.string().max(2_000)).max(DOC_MAX_SHEET_COLS))
    .min(1)
    .max(DOC_MAX_SHEET_ROWS),
});

export type SheetSpec = z.infer<typeof sheetSpecSchema>;
export const sheetsSpecSchema = z.array(sheetSpecSchema).min(1).max(DOC_MAX_SHEETS);

// —— 清洗 ——

/** 去掉控制字符、统一换行、压掉过多的空行；模型偶尔会把提示词里的零宽字符带进来 */
export function normalizeDocText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‍﻿]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function clip(text: string, max: number): string {
  const normalized = normalizeDocText(text);
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function alignRow(row: string[], count: number): string[] {
  const cells = row.slice(0, count).map((c) => clip(c, 2_000));
  while (cells.length < count) cells.push("");
  return cells;
}

/** 清洗稿件：夹长度、对齐表格列数、丢弃空块 */
export function normalizeDocument(input: DocumentSpec): DocumentSpec {
  const blocks: DocBlock[] = [];
  for (const block of input.blocks.slice(0, DOC_MAX_BLOCKS)) {
    switch (block.type) {
      case "heading": {
        const text = clip(block.text, 300);
        if (text) blocks.push({ type: "heading", level: block.level ?? 1, text });
        break;
      }
      case "paragraph": {
        const text = clip(block.text, DOC_MAX_BLOCK_TEXT);
        if (text) blocks.push({ type: "paragraph", text });
        break;
      }
      case "list": {
        const items = block.items
          .map((i) => clip(i, 2_000))
          .filter(Boolean)
          .slice(0, 200);
        if (items.length > 0) blocks.push({ type: "list", ordered: block.ordered, items });
        break;
      }
      case "table": {
        const headers = block.headers.slice(0, DOC_MAX_COLS).map((h) => clip(h, 200));
        if (headers.length === 0) break;
        const rows = block.rows
          .slice(0, DOC_MAX_TABLE_ROWS)
          .map((row) => alignRow(row, headers.length));
        if (rows.length > 0) {
          blocks.push({
            type: "table",
            headers,
            rows,
            ...(block.caption ? { caption: clip(block.caption, 300) } : {}),
          });
        }
        break;
      }
      case "quote": {
        const text = clip(block.text, DOC_MAX_BLOCK_TEXT);
        if (text) blocks.push({ type: "quote", text });
        break;
      }
      case "code": {
        const text = clip(block.text, DOC_MAX_BLOCK_TEXT);
        if (text) {
          blocks.push({
            type: "code",
            text,
            ...(block.language ? { language: clip(block.language, 40) } : {}),
          });
        }
        break;
      }
      case "divider":
      case "pageBreak":
        blocks.push(block);
        break;
      case "callout": {
        const text = clip(block.text, DOC_MAX_BLOCK_TEXT);
        if (text) {
          blocks.push({
            type: "callout",
            tone: block.tone ?? "info",
            ...(block.title ? { title: clip(block.title, 200) } : {}),
            text,
          });
        }
        break;
      }
      case "stats": {
        const items = block.items
          .map((i) => ({ label: clip(i.label, 60), value: clip(i.value, 40) }))
          .filter((i) => i.label && i.value)
          .slice(0, 4);
        if (items.length > 0) blocks.push({ type: "stats", items });
        break;
      }
    }
  }
  if (blocks.length === 0) {
    throw new Error("文档没有任何内容块");
  }
  return {
    ...(input.title ? { title: clip(input.title, 200) } : {}),
    ...(input.subtitle ? { subtitle: clip(input.subtitle, 400) } : {}),
    ...(input.author ? { author: clip(input.author, 120) } : {}),
    ...(input.date ? { date: clip(input.date, 60) } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    blocks,
  };
}

export function normalizePresentation(input: PresentationSpec): PresentationSpec {
  const slides: SlideSpec[] = [];
  for (const slide of input.slides.slice(0, DOC_MAX_SLIDES)) {
    const next: SlideSpec = {
      ...(slide.layout ? { layout: slide.layout } : {}),
      ...(slide.title ? { title: clip(slide.title, 200) } : {}),
      ...(slide.subtitle ? { subtitle: clip(slide.subtitle, 400) } : {}),
      ...(slide.notes ? { notes: clip(slide.notes, 2_000) } : {}),
    };
    if (slide.bullets) {
      const bullets = slide.bullets
        .map((b) => clip(b, 500))
        .filter(Boolean)
        .slice(0, 12);
      if (bullets.length > 0) next.bullets = bullets;
    }
    if (slide.table) {
      const headers = slide.table.headers.slice(0, 8).map((h) => clip(h, 200));
      const rows = slide.table.rows
        .slice(0, 20)
        .map((row) => alignRow(row, headers.length));
      if (headers.length > 0 && rows.length > 0) next.table = { headers, rows };
    }
    if (slide.quote) {
      const quote = clip(slide.quote, 500);
      if (quote) next.quote = quote;
    }
    if (slide.stats) {
      const stats = slide.stats
        .map((s) => ({ label: clip(s.label, 40), value: clip(s.value, 24) }))
        .filter((s) => s.label && s.value)
        .slice(0, 4);
      if (stats.length > 0) next.stats = stats;
    }
    // 没有任何可视内容的页直接丢掉（备注页/空页）
    if (
      !next.title &&
      !next.subtitle &&
      !next.bullets &&
      !next.table &&
      !next.quote &&
      !next.stats
    ) {
      continue;
    }
    slides.push(next);
  }
  if (slides.length === 0) throw new Error("演示文稿没有任何幻灯片");
  return {
    ...(input.title ? { title: clip(input.title, 200) } : {}),
    ...(input.subtitle ? { subtitle: clip(input.subtitle, 300) } : {}),
    ...(input.author ? { author: clip(input.author, 120) } : {}),
    ...(input.date ? { date: clip(input.date, 60) } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    slides,
  };
}

export function normalizeSheets(input: SheetSpec[]): SheetSpec[] {
  const sheets = input.slice(0, DOC_MAX_SHEETS).map((sheet, index) => {
    const headers = (sheet.headers ?? []).slice(0, DOC_MAX_SHEET_COLS).map((h) => clip(h, 200));
    const rows = sheet.rows.slice(0, DOC_MAX_SHEET_ROWS).map((row) => {
      const cells = row.slice(0, DOC_MAX_SHEET_COLS).map((c) => clip(c, 2_000));
      while (headers.length > 0 && cells.length < headers.length) cells.push("");
      return cells;
    });
    return {
      name: clip(sheet.name ?? `Sheet${index + 1}`, 31) || `Sheet${index + 1}`,
      ...(headers.length > 0 ? { headers } : {}),
      rows,
    };
  });
  if (sheets.length === 0) throw new Error("表格文件没有内容");
  return sheets;
}

// —— 纯文本兜底：把 Markdown 风格正文解析成块 ——

/** 去掉行内 Markdown 记号，保留可读文本（Word/PDF 里不需要星号） */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/<br\s*\/?>/gi, "\n");
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => stripInlineMarkdown(cell.trim()));
}

const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

/** 把一段 Markdown 风格的文本解析成文档块（生成 docx / pdf 时的兜底排版） */
export function blocksFromText(text: string): DocBlock[] {
  const lines = normalizeDocText(text).split("\n");
  const blocks: DocBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: { lines: string[]; language?: string } | null = null;
  let table: { headers: string[]; rows: string[][] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const merged = paragraph.join("\n").trim();
    if (merged) blocks.push({ type: "paragraph", text: merged });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length > 0) blocks.push({ type: "list", ...list });
    list = null;
  };
  const flushTable = () => {
    if (table && table.rows.length > 0) blocks.push({ type: "table", ...table });
    table = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");

    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push({
          type: "code",
          text: code.lines.join("\n"),
          ...(code.language ? { language: code.language } : {}),
        });
        code = null;
      } else {
        code.lines.push(raw);
      }
      continue;
    }

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flushAll();
      code = { lines: [], ...(fence[1] ? { language: fence[1] } : {}) };
      continue;
    }

    if (!line.trim()) {
      flushAll();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushAll();
      blocks.push({
        type: "heading",
        level: Math.min(heading[1].length, 3) as 1 | 2 | 3,
        text: stripInlineMarkdown(heading[2]).trim(),
      });
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushAll();
      blocks.push({ type: "divider" });
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushAll();
      blocks.push({ type: "quote", text: stripInlineMarkdown(quote[1]).trim() });
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      flushTable();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { ordered: isOrdered, items: [] };
      }
      list.items.push(stripInlineMarkdown((bullet ?? ordered)![1]).trim());
      continue;
    }

    if (line.trim().startsWith("|")) {
      const cells = splitTableRow(line);
      if (TABLE_SEPARATOR.test(line.trim())) continue;
      flushParagraph();
      flushList();
      if (!table) {
        // 下一行是分隔行 → 本行是表头
        table = { headers: cells, rows: [] };
      } else if (table.rows.length === 0 && cells.every((c) => /^:?-{2,}:?$/.test(c))) {
        continue;
      } else {
        table.rows.push(cells);
      }
      continue;
    }

    // 普通文本：连续的普通行合并成一段（表格需要立刻收口）
    flushList();
    flushTable();
    paragraph.push(stripInlineMarkdown(line));
  }

  if (code) {
    blocks.push({
      type: "code",
      text: code.lines.join("\n"),
      ...(code.language ? { language: code.language } : {}),
    });
  }
  flushAll();

  if (blocks.length === 0) {
    const fallback = normalizeDocText(text);
    if (fallback) blocks.push({ type: "paragraph", text: fallback });
  }
  return blocks;
}

/** 只给纯文本时构造一份文档：首个一级标题提升为文档标题 */
export function documentFromText(content: string, title?: string): DocumentSpec {
  const blocks = blocksFromText(content);
  let docTitle = title?.trim();
  if (!docTitle && blocks[0]?.type === "heading" && blocks[0].level === 1) {
    docTitle = blocks[0].text;
    blocks.shift();
  }
  if (blocks.length === 0) {
    throw new Error("文档没有任何内容块");
  }
  return { ...(docTitle ? { title: docTitle } : {}), blocks };
}

/** 只给纯文本时拆成幻灯片：按 #/## 标题分页，没有标题就按段落切 */
export function presentationFromText(content: string, title?: string): PresentationSpec {
  const blocks = blocksFromText(content);
  const slides: SlideSpec[] = [];
  let current: SlideSpec | null = null;

  const pushCurrent = () => {
    if (current && (current.title || current.bullets?.length || current.subtitle)) {
      slides.push(current);
    }
    current = null;
  };

  for (const block of blocks) {
    if (block.type === "heading" && block.level <= 2) {
      pushCurrent();
      current = { layout: "bullets", title: block.text, bullets: [] };
      continue;
    }
    if (!current) {
      current = { layout: "bullets", bullets: [] };
    }
    if (block.type === "heading") {
      current.bullets!.push(block.text);
    } else if (block.type === "paragraph") {
      // 长段落按句号拆成要点，避免一页塞一段长文
      const parts = block.text
        .split(/(?<=[。！？!?；;])\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        if (part.length > 160) {
          current.bullets!.push(part.slice(0, 160) + "…");
        } else {
          current.bullets!.push(part);
        }
      }
    } else if (block.type === "list") {
      current.bullets!.push(...block.items);
    } else if (block.type === "quote") {
      current.bullets!.push(`“${block.text}”`);
    } else if (block.type === "table") {
      pushCurrent();
      slides.push({ layout: "table", title: block.caption || "数据", table: block });
    } else if (block.type === "stats") {
      pushCurrent();
      slides.push({ layout: "stats", title: "关键数据", stats: block.items });
    }
    if (current && current.bullets && current.bullets.length >= 8) pushCurrent();
  }
  pushCurrent();

  const first = slides[0];
  const fallbackTitle = title?.trim() || first?.title;
  // 首屏封面：有标题就单独做一页封面，正文里不再重复
  const withCover: SlideSpec[] = fallbackTitle
    ? [{ layout: "title", title: fallbackTitle, subtitle: undefined }, ...slides]
    : slides;

  return {
    ...(fallbackTitle ? { title: fallbackTitle } : {}),
    slides: withCover,
  };
}

/** 文档的大致字符量（决定是否超过生成上限） */
export function documentCharCount(spec: DocumentSpec): number {
  let total = (spec.title?.length ?? 0) + (spec.subtitle?.length ?? 0);
  for (const block of spec.blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
      case "quote":
      case "code":
        total += block.text.length;
        break;
      case "list":
        total += block.items.reduce((n, i) => n + i.length, 0);
        break;
      case "table":
        total += block.headers.join("").length;
        total += block.rows.reduce((n, r) => n + r.join("").length, 0);
        break;
      case "callout":
        total += block.text.length + (block.title?.length ?? 0);
        break;
      case "stats":
        total += block.items.reduce((n, i) => n + i.label.length + i.value.length, 0);
        break;
      default:
        break;
    }
  }
  return total;
}
