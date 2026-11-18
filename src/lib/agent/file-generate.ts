import type { z } from "zod";
import { AppError } from "@/lib/errors";
import {
  documentCharCount,
  documentFromText,
  documentSpecSchema,
  normalizeDocument,
  normalizePresentation,
  normalizeSheets,
  presentationFromText,
  presentationSpecSchema,
  sheetsSpecSchema,
  type DocumentSpec,
  type PresentationSpec,
  type SheetSpec,
} from "./document-spec";
import { docxFromDocument } from "./docx-generate";
import { pdfFromDocument } from "./pdf-generate";
import { pptxFromPresentation } from "./pptx-generate";
import { xlsxFromCsv, xlsxFromSheets } from "./xlsx-generate";

/**
 * 助手「生成文件」。
 *
 * 模型给文件名 + 内容，这里按扩展名编码成真实文件：
 * - 文本类（txt/md/csv/json/html/xml/svg/代码…）：UTF-8 原样写入；
 * - xlsx：`sheets` 结构（多工作表、列宽自适应）或 CSV 正文；
 * - docx / pdf：`document` 结构化稿件（标题、章节、列表、表格、引用、代码、横幅、卡片组、
 *   时间线、进度条、分页…），还可用 font / headingFont 选字体；只给纯文本时用 Markdown 解析兜底；
 * - pptx：`slides` 结构化幻灯片（封面/章节/要点/表格/引用/数据卡/卡片组/时间线/左右对比/
 *   原生图表/结束页），只给纯文本时按标题与段落自动拆页。
 *
 * PDF 与 PPT 是**原生生成**：PDF 用 pdf-lib 排版并嵌入中文字体子集，
 * PPT 用 pptxgenjs 生成可编辑的文本框与表格 —— 都不是把网页截成图片。
 */

/** 生成正文的长度上限（约 20 万字符，足够一份长文档或几万行 CSV） */
export const GENERATE_MAX_CHARS = 200_000;

export const GENERATE_SUPPORTED_LABEL =
  "txt、md、csv、json、html、xml、svg、yml/toml/ini、常见代码文件，以及 xlsx、docx、pdf、pptx";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PDF_MIME = "application/pdf";

const TEXT_MIME: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  toml: "application/toml; charset=utf-8",
  ini: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  scss: "text/x-scss; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  ts: "text/typescript; charset=utf-8",
  tsx: "text/typescript; charset=utf-8",
  py: "text/x-python; charset=utf-8",
  java: "text/x-java; charset=utf-8",
  c: "text/x-c; charset=utf-8",
  h: "text/x-c; charset=utf-8",
  cpp: "text/x-c++; charset=utf-8",
  cs: "text/x-csharp; charset=utf-8",
  go: "text/x-go; charset=utf-8",
  rs: "text/x-rust; charset=utf-8",
  php: "text/x-php; charset=utf-8",
  rb: "text/x-ruby; charset=utf-8",
  sh: "text/x-sh; charset=utf-8",
  bash: "text/x-sh; charset=utf-8",
  sql: "application/sql; charset=utf-8",
  tex: "text/x-tex; charset=utf-8",
};

export function fileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export type GenerateFileInput = {
  filename: string;
  /** 纯文本正文；文本类格式必填，xlsx/docx/pdf/pptx 在没给结构化稿件时用它兜底 */
  content?: string;
  /** 仅 xlsx（CSV 路径）：工作表名 */
  sheetName?: string;
  /** docx / pdf：结构化稿件 */
  document?: DocumentSpec;
  /** pptx：结构化幻灯片 */
  slides?: PresentationSpec;
  /** xlsx：多工作表 */
  sheets?: SheetSpec[];
};

export type GeneratedFile = {
  filename: string;
  mimeType: string;
  data: Buffer;
};

function parseSpec<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `（${issue.path.join(".")}）` : "";
    throw new AppError(`${label}格式不对${path}：${issue?.message ?? "无法解析"}`);
  }
  return result.data;
}

function normalized<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : "文档结构不合法");
  }
}

function checkSize(chars: number): void {
  if (chars > GENERATE_MAX_CHARS) {
    throw new AppError(`生成内容最多 ${GENERATE_MAX_CHARS} 字符，请拆成多个文件`);
  }
}

export async function generateFile(input: GenerateFileInput): Promise<GeneratedFile> {
  const filename = input.filename.trim().slice(0, 200);
  if (!filename) throw new AppError("请给出文件名");

  const ext = fileExtension(filename);
  if (!ext) throw new AppError("文件名要带扩展名，例如 report.md / 周报.docx / 汇报.pptx");

  const content = input.content ?? "";
  if (content.length > GENERATE_MAX_CHARS) {
    throw new AppError(`生成内容最多 ${GENERATE_MAX_CHARS} 字符，请拆成多个文件`);
  }

  if (ext === "xlsx") {
    if (input.sheets && input.sheets.length > 0) {
      const sheets = normalized(() =>
        normalizeSheets(parseSpec(sheetsSpecSchema, input.sheets, "工作表结构")),
      );
      const chars = sheets.reduce(
        (sum, sheet) =>
          sum +
          (sheet.headers?.join("").length ?? 0) +
          sheet.rows.reduce((n, row) => n + row.join("").length, 0),
        0,
      );
      checkSize(chars);
      return { filename, mimeType: XLSX_MIME, data: await xlsxFromSheets(sheets) };
    }
    if (!content) {
      throw new AppError("生成 Excel 请给 CSV 正文（第一行表头），或用 sheets 描述多个工作表");
    }
    return { filename, mimeType: XLSX_MIME, data: await xlsxFromCsv(content, input.sheetName) };
  }

  if (ext === "docx" || ext === "pdf") {
    const spec = input.document
      ? normalized(() => normalizeDocument(parseSpec(documentSpecSchema, input.document, "文档结构")))
      : (() => {
          if (!content.trim()) {
            throw new AppError("生成文档请给 content 正文，或用 document 描述章节、表格与版式");
          }
          return normalized(() => normalizeDocument(documentFromText(content)));
        })();
    checkSize(documentCharCount(spec));
    if (ext === "docx") {
      return { filename, mimeType: DOCX_MIME, data: await docxFromDocument(spec) };
    }
    return { filename, mimeType: PDF_MIME, data: await pdfFromDocument(spec) };
  }

  if (ext === "pptx") {
    const spec = input.slides
      ? normalized(() =>
          normalizePresentation(parseSpec(presentationSpecSchema, input.slides, "幻灯片结构")),
        )
      : (() => {
          if (!content.trim()) {
            throw new AppError("生成 PPT 请给 content 大纲，或用 slides 描述每一页");
          }
          return normalized(() => normalizePresentation(presentationFromText(content)));
        })();
    checkSize(JSON.stringify(spec).length);
    return { filename, mimeType: PPTX_MIME, data: await pptxFromPresentation(spec) };
  }

  if (ext === "ppt" || ext === "doc" || ext === "xls") {
    throw new AppError(
      `不支持旧的 .${ext} 格式；请改生成 .${ext === "xls" ? "xlsx" : ext === "doc" ? "docx" : "pptx"}`,
    );
  }

  const mimeType = TEXT_MIME[ext];
  if (!mimeType) {
    throw new AppError(`暂不支持生成 .${ext} 文件；支持 ${GENERATE_SUPPORTED_LABEL}`);
  }
  if (!content) throw new AppError("文件内容不能为空");
  return { filename, mimeType, data: Buffer.from(content, "utf8") };
}
