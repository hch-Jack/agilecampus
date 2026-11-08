/**
 * Word / Excel 附件在线预览的解析层（仅浏览器端调用）：
 * - docx / docm：docx-preview 按页保真渲染（样式、表格、图片、页眉页脚），
 *   mammoth 作为解析失败时的兜底（语义 HTML）。
 * - doc：Word 97-2003 二进制格式，用 CFB 拆容器 + 解析片段表（piece table）
 *   抽出正文纯文本；旧版格式没有可靠的纯 JS 排版还原方案。
 * - xlsx / xls / xlsm / xlsb / ods：SheetJS 解析，自绘表格保留列宽、行高、
 *   合并单元格、数字格式与基础字体/底色/边框（sheet_to_html 会丢掉这些）。
 * - pptx：pptx-preview，见组件层。
 *
 * 体积较大的库只被预览弹窗动态 import，各自进独立 chunk，不拖慢首屏。
 *
 * 安全口径：mammoth 输出本身会转义正文文本，这里再做一层 DOM 净化后经
 * dangerouslySetInnerHTML 展示；Excel 自绘 HTML 全程转义单元格文本，
 * 样式值只接受校验过的十六进制颜色与固定枚举，不让文件内容注入标记或脚本。
 */
import * as CFB from "cfb";
import * as XLSX from "xlsx";
import type mammothMain from "mammoth";
// 浏览器端用 mammoth 预构建 UMD bundle（lib 入口引 node 依赖），类型借主入口的声明
import mammothBrowser from "mammoth/mammoth.browser";

const mammoth = mammothBrowser as unknown as typeof mammothMain;

// 单表渲染上限：超出后截断展示并提示下载看全量，防超大表卡死页面
const MAX_SHEET_ROWS = 2000;
const MAX_SHEET_COLS = 120;
// 旧版 .doc 抽出的正文上限（字符）：异常文件可能报一个巨大的 ccpText
const MAX_DOC_CHARS = 2_000_000;

export type SheetTable = {
  name: string;
  html: string;
  truncated: boolean;
  colsTruncated: boolean;
};

/** 兜底净化：预览 HTML 里不允许出现可执行内容（mammoth 已转义文本，此层防样式表等夹带） */
function sanitizeHtml(html: string): string {
  // 单测跑在 node（无 DOMParser）：mammoth 已转义文本，直接放行
  if (typeof DOMParser === "undefined") return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of [...doc.body.querySelectorAll("script, style, iframe, object, embed, link, meta, form, base")])
    el.remove();
  for (const el of [...doc.body.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src") && value.startsWith("javascript:")))
        el.removeAttribute(attr.name);
    }
  }
  return doc.body.innerHTML;
}

/** docx → 语义 HTML（兜底路径；排版不如 docx-preview 保真） */
export async function docxToHtml(buf: ArrayBuffer): Promise<string> {
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  return sanitizeHtml(result.value);
}

/**
 * docx → 按页 HTML。docx-preview 直接建 DOM 节点（不做字符串注入），
 * 样式写进独立的 style 容器，组件卸载时随容器一起清掉。
 */
export async function renderDocx(
  buf: ArrayBuffer,
  bodyEl: HTMLElement,
  styleEl: HTMLElement,
): Promise<void> {
  const { renderAsync } = await import("docx-preview");
  bodyEl.replaceChildren();
  styleEl.replaceChildren();
  await renderAsync(buf, bodyEl, styleEl, {
    // 默认前缀 "docx"（.docx-wrapper / section.docx），组件里的覆盖样式按这个写
    className: "docx",
    inWrapper: true,
    breakPages: true,
    useBase64URL: true,
    ignoreWidth: false,
    ignoreHeight: false,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    experimental: true,
  });
  sanitizeRenderedDom(bodyEl);
  // docx-preview 自带样式把 wrapper 刷成灰色并以 30px 内边距套白页；它的 <style> 不在
  // Tailwind 的 @layer 里，工具类盖不住，所以直接改内联样式（只在 docx 子树内生效）。
  const wrapper = bodyEl.querySelector<HTMLElement>(".docx-wrapper");
  if (wrapper) {
    wrapper.style.background = "transparent";
    wrapper.style.padding = "0";
  }
}

/** docx-preview 直接建 DOM 节点：仍兜底清掉可执行属性，防恶意文档夹带脚本/伪协议链接 */
function sanitizeRenderedDom(root: HTMLElement): void {
  for (const el of [
    ...root.querySelectorAll("script, style, iframe, object, embed, link, meta, form, base"),
  ])
    el.remove();
  for (const el of [...root.querySelectorAll("*")]) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "src" || name === "xlink:href") &&
          (value.startsWith("javascript:") || value.startsWith("data:text/html")))
      )
        el.removeAttribute(attr.name);
    }
  }
}

// ───────────────────────────── 旧版 .doc ─────────────────────────────

const DOC_IDENT = 0xa5ec;
// FibBase 之后的固定偏移（Word 97 及以后）
const FIB_FLAGS = 0x0a;
const FIB_FCMIN = 0x18;
const FIB_FCMAC = 0x1c;
const FIB_CCPTEXT = 0x4c;
const FIB_FCCLX = 0x01a2;
const FIB_LBCCLX = 0x01a6;

function u16(b: Uint8Array, at: number): number {
  return b[at] | (b[at + 1] << 8);
}

function u32(b: Uint8Array, at: number): number {
  return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
}

function streamOf(container: CFB.CFB$Container, name: string): Uint8Array | null {
  const entry = CFB.find(container, name);
  if (!entry?.content) return null;
  const content = entry.content;
  return content instanceof Uint8Array ? content : Uint8Array.from(content);
}

// CP1252 的 0x80-0x9F 段与 Latin-1 不同；TextDecoder 在浏览器与完整 ICU 的 node 都支持
let cp1252Decoder: TextDecoder | null | undefined;
function decodeCp1252(bytes: Uint8Array): string {
  if (cp1252Decoder === undefined) {
    try {
      cp1252Decoder = new TextDecoder("windows-1252");
    } catch {
      cp1252Decoder = null;
    }
  }
  if (cp1252Decoder) return cp1252Decoder.decode(bytes);
  return Array.from(bytes, (b) => (b < 0x80 || b >= 0xa0 ? String.fromCharCode(b) : "?")).join("");
}

/** Word 会把段落/单元格/分页等标记混在正文里，这里翻成可读文本并去掉域代码 */
function normalizeDocText(raw: string): string {
  let out = "";
  // 域（field）：\x13 指令开始 → \x14 结果开始 → \x15 结束；嵌套用深度计数
  let fieldDepth = 0;
  let inInstruction = false;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (code === 0x13) {
      fieldDepth++;
      inInstruction = true;
      continue;
    }
    if (code === 0x14) {
      inInstruction = false;
      continue;
    }
    if (code === 0x15) {
      fieldDepth = Math.max(0, fieldDepth - 1);
      inInstruction = fieldDepth > 0;
      continue;
    }
    if (inInstruction) continue;
    if (code === 0x0d || code === 0x0b || code === 0x0c) {
      out += "\n";
    } else if (code === 0x07) {
      out += "\t";
    } else if (code === 0x1e) {
      out += "-";
    } else if (code === 0x1f || code === 0x05 || code === 0x01 || code === 0x02) {
      // 可选连字符、批注引用、图片/脚注锚点：正文里不展示
    } else if (code < 0x20 && code !== 0x09) {
      continue;
    } else {
      out += ch;
    }
  }
  // 连续空行收成两行，末尾空行去掉
  return out
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

type Piece = { cpStart: number; cpEnd: number; fc: number; compressed: boolean };

/** 解析 CLX（位于 0Table/1Table 流）里的片段表 PlcPcd */
function parsePieces(clx: Uint8Array): Piece[] | null {
  let pos = 0;
  while (pos < clx.length) {
    const type = clx[pos];
    if (type === 0x01) {
      // Prc：格式信息，跳过
      if (pos + 3 > clx.length) return null;
      const cb = u16(clx, pos + 1);
      pos += 3 + cb;
    } else if (type === 0x02) {
      // Pcdt
      if (pos + 5 > clx.length) return null;
      const lcb = u32(clx, pos + 1);
      const plc = clx.subarray(pos + 5, Math.min(pos + 5 + lcb, clx.length));
      // PlcPcd = (n+1) 个 CP（4 字节）+ n 个 PCD（8 字节）
      const n = Math.floor((plc.length - 4) / 12);
      if (n <= 0) return null;
      const pcdStart = (n + 1) * 4;
      const pieces: Piece[] = [];
      for (let i = 0; i < n; i++) {
        const cpStart = u32(plc, i * 4);
        const cpEnd = u32(plc, i * 4 + 4);
        const fc = u32(plc, pcdStart + i * 8 + 2);
        pieces.push({
          cpStart,
          cpEnd,
          fc: fc & 0x3fffffff,
          compressed: (fc & 0x40000000) !== 0,
        });
      }
      return pieces;
    } else {
      return null;
    }
  }
  return null;
}

function extractPieceText(word: Uint8Array, piece: Piece): string {
  const count = Math.min(piece.cpEnd - piece.cpStart, MAX_DOC_CHARS);
  if (count <= 0) return "";
  const offset = piece.compressed ? Math.floor(piece.fc / 2) : piece.fc;
  const bytes = piece.compressed ? count : count * 2;
  if (offset < 0 || offset + bytes > word.length) return "";
  const slice = word.subarray(offset, offset + bytes);
  if (piece.compressed) return decodeCp1252(slice);
  let out = "";
  for (let i = 0; i + 1 < slice.length; i += 2) out += String.fromCharCode(slice[i] | (slice[i + 1] << 8));
  return out;
}

/**
 * Word 97-2003（.doc/.dot）二进制文档 → 正文纯文本。
 * Word 6/95 没有片段表，退回 FibBase 的 fcMin/fcMac 区间按 CP1252 读。
 */
export function legacyDocToText(buf: ArrayBuffer): string {
  const container = CFB.read(new Uint8Array(buf), { type: "array" });
  const word = streamOf(container, "WordDocument");
  if (!word || word.length < 0x20 || u16(word, 0) !== DOC_IDENT)
    throw new Error("不是有效的 Word 文档");

  const nFib = u16(word, 2);
  if (nFib >= 101) {
    const flags = u16(word, FIB_FLAGS);
    const tableName = flags & 0x0200 ? "1Table" : "0Table";
    const table = streamOf(container, tableName);
    if (table) {
      const fcClx = u32(word, FIB_FCCLX);
      const lcbClx = u32(word, FIB_LBCCLX);
      if (fcClx > 0 && lcbClx > 0 && fcClx + lcbClx <= table.length) {
        const pieces = parsePieces(table.subarray(fcClx, fcClx + lcbClx));
        if (pieces && pieces.length > 0) {
          const ccpText = Math.min(u32(word, FIB_CCPTEXT) || Number.MAX_SAFE_INTEGER, MAX_DOC_CHARS);
          let text = "";
          for (const piece of pieces) {
            if (piece.cpStart >= ccpText) break;
            const clipped = {
              ...piece,
              cpEnd: Math.min(piece.cpEnd, ccpText),
            };
            text += extractPieceText(word, clipped);
            if (text.length >= MAX_DOC_CHARS) break;
          }
          return normalizeDocText(text.slice(0, MAX_DOC_CHARS));
        }
      }
    }
  }

  // Word 6/95 或片段表损坏：读 FibBase 的连续正文区间
  const fcMin = u32(word, FIB_FCMIN);
  const fcMac = u32(word, FIB_FCMAC);
  if (fcMac > fcMin && fcMac <= word.length)
    return normalizeDocText(decodeCp1252(word.subarray(fcMin, fcMac)));
  throw new Error("Word 文档内容无法解析");
}

// ───────────────────────────── Excel ─────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** ARGB / RGB → CSS 颜色；非法值一律丢弃（不把文件里的字符串拼进样式） */
function cssColor(rgb: string | undefined): string | null {
  if (!rgb) return null;
  const v = rgb.replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  if (/^[0-9a-fA-F]{8}$/.test(v)) {
    const a = parseInt(v.slice(0, 2), 16);
    const r = parseInt(v.slice(2, 4), 16);
    const g = parseInt(v.slice(4, 6), 16);
    const b = parseInt(v.slice(6, 8), 16);
    if (a === 0) return null;
    return a === 255 ? `#${v.slice(2)}` : `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
  }
  return null;
}

const BORDER_STYLES: Record<string, string> = {
  thin: "1px solid",
  hair: "1px solid",
  medium: "2px solid",
  thick: "3px solid",
  dashed: "1px dashed",
  dotted: "1px dotted",
  double: "3px double",
  mediumDashed: "2px dashed",
  mediumDashDot: "2px dashed",
  mediumDashDotDot: "2px dashed",
  dashDot: "1px dashed",
  dashDotDot: "1px dashed",
  slantDashDot: "1px dashed",
};

// SheetJS 的 cellStyles 输出没有公开的完整 TS 类型，这里按实际结构声明用到的字段
type StyleColor = { rgb?: string };
type StyleEdge = { style?: string; color?: StyleColor };
type SheetCellStyle = {
  font?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    sz?: number;
    name?: string;
    color?: StyleColor;
  };
  fill?: { patternType?: string; fgColor?: StyleColor };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean; indent?: number };
  border?: { top?: StyleEdge; right?: StyleEdge; bottom?: StyleEdge; left?: StyleEdge };
};

// Excel 默认列宽 8.43 字符、默认行高 14.4 磅，换算成 CSS 像素
const DEFAULT_COL_PX = 64;
const MIN_COL_PX = 8;
const MAX_COL_PX = 600;
const DEFAULT_ROW_PX = 19;
// Excel 列宽单位按默认字体（Calibri 11）最大数字宽约 7px 换算：wch × 7 + 5
const CHAR_PX = 7;

const H_ALIGN: Record<string, string> = {
  center: "center",
  centerContinuous: "center",
  right: "right",
  left: "left",
  justified: "justify",
  fill: "left",
};
const V_ALIGN: Record<string, string> = {
  top: "top",
  center: "middle",
  bottom: "bottom",
  justified: "middle",
  distributed: "middle",
};

/** 列宽：优先按字符宽换算（SheetJS 的 wpx 用 MDW=6，比 Excel 实际渲染窄一截） */
function colWidthPx(info: XLSX.ColInfo | undefined): number {
  if (!info) return DEFAULT_COL_PX;
  const chars = info.wch ?? info.width;
  const px = chars !== undefined ? Math.round(chars * CHAR_PX + 5) : info.wpx;
  if (px === undefined) return DEFAULT_COL_PX;
  return Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(px)));
}

function rowHeightPx(info: XLSX.RowInfo | undefined): number {
  if (!info) return DEFAULT_ROW_PX;
  // 读取端 hpx 可能是把 pt 当 px 回显的，优先用 hpt 自己换算（1pt = 4/3px）
  if (info.hpt !== undefined) return Math.max(0, Math.round((info.hpt * 4) / 3));
  if (info.hpx !== undefined) return Math.max(0, Math.round(info.hpx));
  return DEFAULT_ROW_PX;
}

/** 字体名只保留字母/数字/汉字与空格下划线连字符，挡掉样式注入 */
function safeFontFamily(name: string): string {
  return name.replace(/[^\p{L}\p{N} _-]/gu, "").trim();
}

function borderCss(border: SheetCellStyle["border"]): string {
  if (!border) return "";
  let css = "";
  for (const side of ["top", "right", "bottom", "left"] as const) {
    const edge = border[side];
    if (!edge?.style) continue;
    const line = BORDER_STYLES[edge.style] ?? "1px solid";
    // 边框没给颜色时 Excel 用自动色（近黑），不是浅灰
    const color = cssColor(edge.color?.rgb) ?? "#000000";
    css += `border-${side}:${line} ${color};`;
  }
  return css;
}

function cellCss(cell: XLSX.CellObject | undefined, text: string, clip: boolean): string {
  const style = (cell as { s?: SheetCellStyle } | undefined)?.s;
  const alignment = style?.alignment;
  // Excel 单元格左右各有约 3px 内边距
  let css = "padding:0 3px;";
  if (style) {
    const font = style.font;
    if (font) {
      if (font.bold) css += "font-weight:700;";
      if (font.italic) css += "font-style:italic;";
      const decorate = [font.underline ? "underline" : "", font.strike ? "line-through" : ""].filter(Boolean);
      if (decorate.length) css += `text-decoration:${decorate.join(" ")};`;
      if (font.sz) css += `font-size:${font.sz}pt;`;
      if (font.name) {
        const family = safeFontFamily(font.name);
        if (family) css += `font-family:${family},Calibri,sans-serif;`;
      }
      const color = cssColor(font.color?.rgb);
      if (color && color.toLowerCase() !== "#000000") css += `color:${color};`;
    }
    const fill = style.fill;
    if (fill?.patternType && fill.patternType !== "none") {
      const bg = cssColor(fill.fgColor?.rgb);
      if (bg && bg.toLowerCase() !== "#ffffff") css += `background-color:${bg};`;
    }
    css += borderCss(style.border);
  }
  // 纵向默认与 Excel 一致：底对齐
  css += `vertical-align:${(alignment?.vertical && V_ALIGN[alignment.vertical]) || "bottom"};`;
  // 缩进：Excel 一个缩进单位约等于 3 个字符宽
  if (alignment?.indent) css += `padding-left:${3 + Math.round(alignment.indent) * 9}px;`;
  // 横向对齐：显式样式优先，否则数字/日期右对齐、布尔居中（与 Excel 一致）
  const hAlign = alignment?.horizontal ? H_ALIGN[alignment.horizontal] : undefined;
  if (hAlign) css += `text-align:${hAlign};`;
  else if (cell?.t === "n" || cell?.t === "d") css += "text-align:right;";
  else if (cell?.t === "b") css += "text-align:center;";
  // 只有 Excel 勾了自动换行或单元格里有换行符才折行；其余不换行，
  // 右侧邻格有内容时按 Excel 的做法裁掉溢出，邻格为空则允许溢出显示
  if (alignment?.wrapText || text.includes("\n")) {
    css += "white-space:pre-wrap;word-break:break-word;";
  } else {
    css += clip ? "white-space:nowrap;overflow:hidden;text-overflow:clip;" : "white-space:nowrap;overflow:visible;";
  }
  return css;
}

function cellText(cell: XLSX.CellObject): string {
  try {
    const formatted = XLSX.utils.format_cell(cell);
    return typeof formatted === "string" ? formatted : String(formatted ?? "");
  } catch {
    return cell.v === undefined || cell.v === null ? "" : String(cell.v);
  }
}

/** 在升序原始坐标表里找 [from,to] 覆盖的连续区间，返回起始下标与个数（下标即渲染位置） */
function visibleSpan(index: number[], from: number, to: number): { start: number; count: number } | null {
  let lo = 0;
  let hi = index.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  let end = lo;
  while (end < index.length && index[end] <= to) end++;
  return end > lo ? { start: lo, count: end - lo } : null;
}

function renderSheet(ws: XLSX.WorkSheet): Omit<SheetTable, "name"> {
  if (!ws["!ref"]) return { html: "", truncated: false, colsTruncated: false };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const truncated = range.e.r - range.s.r + 1 > MAX_SHEET_ROWS;
  if (truncated) range.e.r = range.s.r + MAX_SHEET_ROWS - 1;
  const colsTruncated = range.e.c - range.s.c + 1 > MAX_SHEET_COLS;
  if (colsTruncated) range.e.c = range.s.c + MAX_SHEET_COLS - 1;

  // 隐藏的行列在 Excel 里不占位置：先筛出可见行列，合并单元格随之重映射
  const visibleRows: number[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) if (!ws["!rows"]?.[r]?.hidden) visibleRows.push(r);
  const visibleCols: number[] = [];
  for (let c = range.s.c; c <= range.e.c; c++) if (!ws["!cols"]?.[c]?.hidden) visibleCols.push(c);
  if (visibleRows.length === 0 || visibleCols.length === 0)
    return { html: "", truncated, colsTruncated };

  // 合并单元格：左上角铺 rowspan/colspan，被覆盖的格子跳过。
  // 锚点落进隐藏行列时，显示内容仍取真正的左上角单元格（Excel 也这样显示）
  const anchors = new Map<string, { rows: number; cols: number; text: string }>();
  const covered = new Set<string>();
  for (const merge of ws["!merges"] ?? []) {
    const r1 = Math.max(merge.s.r, range.s.r);
    const c1 = Math.max(merge.s.c, range.s.c);
    const r2 = Math.min(merge.e.r, range.e.r);
    const c2 = Math.min(merge.e.c, range.e.c);
    if (r2 < r1 || c2 < c1) continue;
    const rowSpan = visibleSpan(visibleRows, r1, r2);
    const colSpan = visibleSpan(visibleCols, c1, c2);
    if (!rowSpan || !colSpan) continue;
    const anchorCell = ws[XLSX.utils.encode_cell(merge.s)];
    anchors.set(`${rowSpan.start}:${colSpan.start}`, {
      rows: rowSpan.count,
      cols: colSpan.count,
      text: anchorCell ? cellText(anchorCell) : "",
    });
    for (let r = rowSpan.start; r < rowSpan.start + rowSpan.count; r++)
      for (let c = colSpan.start; c < colSpan.start + colSpan.count; c++)
        if (r !== rowSpan.start || c !== colSpan.start) covered.add(`${r}:${c}`);
  }

  // 列宽按 Excel 的字符宽口径换算；table-layout:fixed 保证列宽与表格总宽都能精确还原
  const widths = visibleCols.map((c) => colWidthPx(ws["!cols"]?.[c]));
  const totalWidth = widths.reduce((sum, px) => sum + px, 0);
  const colgroup = widths.map((px) => `<col style="width:${px}px">`).join("");

  const rows: string[] = [];
  for (let ri = 0; ri < visibleRows.length; ri++) {
    const r = visibleRows[ri];
    // 先行取整行文本：一是避免重复 format_cell，二是判断右侧邻格是否有内容（决定裁切还是溢出）
    const rowTexts = visibleCols.map((c) => {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      return cell ? cellText(cell) : "";
    });
    const cells: string[] = [];
    for (let ci = 0; ci < visibleCols.length; ci++) {
      const key = `${ri}:${ci}`;
      if (covered.has(key)) continue;
      const anchor = anchors.get(key);
      const cell = ws[XLSX.utils.encode_cell({ r, c: visibleCols[ci] })];
      const text = anchor ? anchor.text : rowTexts[ci];
      // 跨列的合并格不裁切；普通格右侧邻格有字时按 Excel 规则裁掉溢出
      const clip = !anchor && ci + 1 < visibleCols.length && rowTexts[ci + 1].length > 0;
      const span =
        anchor && (anchor.rows > 1 || anchor.cols > 1)
          ? `${anchor.rows > 1 ? ` rowspan="${anchor.rows}"` : ""}${anchor.cols > 1 ? ` colspan="${anchor.cols}"` : ""}`
          : "";
      const css = cellCss(cell, text, clip);
      const title = text.length > 80 ? ` title="${escapeHtml(text)}"` : "";
      cells.push(`<td${span} style="${css}"${title}>${escapeHtml(text)}</td>`);
    }
    rows.push(`<tr style="height:${rowHeightPx(ws["!rows"]?.[r])}px">${cells.join("")}</tr>`);
  }

  // 字体/字号与 Excel 默认一致（Calibri 11 磅），单元格样式再逐项覆盖
  const html =
    `<table class="ac-xl-sheet" style="border-collapse:collapse;table-layout:fixed;width:${totalWidth}px;` +
    `font-family:Calibri,'Microsoft YaHei',sans-serif;font-size:11pt;line-height:1.35;color:#000">` +
    `<colgroup>${colgroup}</colgroup><tbody>${rows.join("")}</tbody></table>`;
  return { html, truncated, colsTruncated };
}

export async function excelToSheets(buf: ArrayBuffer): Promise<SheetTable[]> {
  // cellStyles 让 SheetJS 顺带解析 styles.xml（字体/底色/边框/对齐）；
  // cellNF 保留数字格式，format_cell 输出和 Excel 里看到的一致
  const wb = XLSX.read(buf, { type: "array", cellStyles: true, cellNF: true });
  return wb.SheetNames.map((name) => ({ name, ...renderSheet(wb.Sheets[name]) }));
}

/** 测试用：只解析不依赖 DOM 的单表渲染 */
export const __test = { renderSheet };
