import { decodeTextWithFallback, detectPreviewKind, TEXT_PREVIEW_MAX_BYTES } from "@/lib/file-preview";

/**
 * 把附件正文抽成纯文本，喂给模型（`read_file` 工具）。
 *
 * 只服务「读内容」这一个目的，和预览层（lib/file-preview-office.ts）分工：
 * - 文本/代码/CSV/JSON：按 UTF-8 → GBK 探测解码；
 * - docx / docm：mammoth 抽正文（不保留排版，够模型理解）；
 * - xlsx / xls / xlsm / ods：SheetJS 逐表转 CSV；
 * - PDF / PPT / 旧版 .doc / 图片等：不做解析，返回一句说明，让模型改走 open_file 预览。
 *
 * 输出上限 `FILE_TEXT_MAX_CHARS`：工具结果进的是模型上下文，不是给人看的文件。
 */

/** 单次抽取的正文上限（字符）。超出即截断并在结果里标记 truncated */
export const FILE_TEXT_MAX_CHARS = 20_000;

export type ExtractedFileText =
  | { text: string; truncated: boolean; note?: never }
  | { note: string; text?: never; truncated?: never };

function extOf(filename: string): string {
  const base = filename.slice(filename.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function toArrayBuffer(data: Buffer): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function clip(text: string): ExtractedFileText {
  // 去掉文本文件里常见的 BOM 与 NUL 占位，避免污染提示词
  const clean = text.replace(/^﻿/, "").replace(/\u0000/g, "");
  if (clean.length <= FILE_TEXT_MAX_CHARS) return { text: clean, truncated: false };
  return { text: clean.slice(0, FILE_TEXT_MAX_CHARS), truncated: true };
}

async function docxToText(data: Buffer): Promise<ExtractedFileText> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: data });
  const text = result.value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return { note: "这个 Word 文档没有可抽取的正文（可能只有图片或表格）" };
  return clip(text);
}

async function excelToText(data: Buffer): Promise<ExtractedFileText> {
  const XLSX = await import("xlsx");
  const wb = XLSX.read(data, { type: "buffer" });
  const parts: string[] = [];
  for (const name of wb.SheetNames.slice(0, 10)) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false });
    parts.push(`## 工作表：${name}\n${csv}`);
    // 逐表累加，已经超上限就不用再解后面的表
    if (parts.join("\n\n").length > FILE_TEXT_MAX_CHARS) break;
  }
  if (parts.length === 0) return { note: "这个表格里没有工作表" };
  return clip(parts.join("\n\n"));
}

/** 抽取正文。解析失败不抛错——把失败原因作为 note 交回模型，让它改走预览/下载 */
export async function extractFileText(input: {
  filename: string;
  mimeType: string | null;
  data: Buffer;
}): Promise<ExtractedFileText> {
  const kind = detectPreviewKind(input.filename, input.mimeType);
  const ext = extOf(input.filename);

  try {
    if (kind === "word" && (ext === "docx" || ext === "docm")) return await docxToText(input.data);
    if (kind === "excel") return await excelToText(input.data);
    if (kind === "text") {
      // 只解前 512KB：超长日志/JSON 的剩余部分对模型没有边际价值
      const slice = input.data.subarray(0, TEXT_PREVIEW_MAX_BYTES);
      const raw = decodeTextWithFallback(toArrayBuffer(slice));
      return clip(raw);
    }
  } catch (e) {
    return {
      note: `文件解析失败（${e instanceof Error ? e.message : "未知错误"}），可以改用 open_file 预览或直接下载查看`,
    };
  }

  const label: Record<string, string> = {
    pdf: "PDF",
    ppt: "PPT",
    doc: "旧版 .doc",
    image: "图片",
    video: "视频",
    audio: "音频",
  };
  const name = label[kind] ?? "该类型";
  return {
    note: `${name}暂不支持抽取正文，可以改用 open_file 预览，或让用户直接下载查看`,
  };
}
