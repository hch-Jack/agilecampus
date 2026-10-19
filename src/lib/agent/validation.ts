import { z } from "zod";

/**
 * 外部输入（REST / 助手段案落库）的日期与文本 schema。
 *
 * - **不要**塞进 AI 工具的 `inputSchema`：`z.preprocess` / `z.iso.date()` 转 JSON Schema
 *   不稳，工具层保持宽松字符串，收紧放在这里与 `commit.ts`。
 * - 建任务：`""` / `null` / 缺省一律视为「未给」。空串若直通 PG `date` 列会 500。
 * - PATCH：`""` 视为「没给」（不改），`null` 才是「清空」。文本同理。
 */

export const optionalDateInput = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null || v.trim() === "" ? undefined : v))
  .pipe(z.iso.date().optional());

export const nullableDatePatch = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.iso.date().nullable().optional());

export const nullableTextPatch = z
  .union([z.string(), z.null()])
  .optional()
  .transform((v) => (v === "" ? undefined : v))
  .pipe(z.string().nullable().optional());
