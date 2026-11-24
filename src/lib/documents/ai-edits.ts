/**
 * 编辑器 AI 修改建议：服务端返回「找到→替换」文本或单元格写入，
 * 客户端把它作为待确认修改挂进各编辑器（tracked changes / proposals）。
 */
export type AiReplacement = {
  find: string;
  replace: string;
  note?: string;
};

export type AiCellEdit = {
  /** 0-based sheet index，缺省为当前/第一张表 */
  sheet?: number;
  /** A1 地址，如 B2 */
  a1: string;
  input: string;
  note?: string;
};

export type AiEditResponse =
  | { kind: "replacements"; summary: string; edits: AiReplacement[] }
  | { kind: "cells"; summary: string; edits: AiCellEdit[] };
