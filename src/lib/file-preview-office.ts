/**
 * Word / Excel 附件在线预览的解析层（仅浏览器端调用）：
 * docx 经 mammoth 转语义 HTML，xlsx/xls 经 SheetJS 逐表转 HTML 表格。
 * mammoth 与 SheetJS 体积较大：本模块只被预览弹窗动态 import，
 * 两个库随之打进独立 chunk，不进主包、不拖慢首屏。
 *
 * 安全口径：mammoth 输出本身会转义正文文本，这里再做一层 DOM 净化
 * （去脚本节点 / on* 属性 / javascript: 链接）后经 dangerouslySetInnerHTML 展示；
 * Excel 的 sheet_to_html 输出只保留 <table> 片段。
 */
import type mammothMain from "mammoth";
// 浏览器端用 mammoth 预构建 UMD bundle（lib 入口引 node 依赖），类型借主入口的声明
import mammothBrowser from "mammoth/mammoth.browser";
import * as XLSX from "xlsx";

const mammoth = mammothBrowser as unknown as typeof mammothMain;

// 单表渲染上限：超出后截断展示并提示下载看全量，防超大表卡死页面
const MAX_SHEET_ROWS = 2000;

export type SheetTable = { name: string; html: string; truncated: boolean };

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

export async function docxToHtml(buf: ArrayBuffer): Promise<string> {
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  return sanitizeHtml(result.value);
}

// sheet_to_html 输出完整 HTML 文档，只截 <table> 段用于内嵌
function extractTable(html: string): string {
  const start = html.indexOf("<table");
  const end = html.lastIndexOf("</table>");
  return start !== -1 && end !== -1 ? html.slice(start, end + "</table>".length) : html;
}

export async function excelToSheets(buf: ArrayBuffer): Promise<SheetTable[]> {
  const wb = XLSX.read(buf, { type: "array" });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    // 超大表截断：改写 !ref 让 sheet_to_html 只渲染前 MAX_SHEET_ROWS 行（wb 不复用，直接改安全）
    let truncated = false;
    if (ws["!ref"]) {
      const range = XLSX.utils.decode_range(ws["!ref"]);
      if (range.e.r - range.s.r + 1 > MAX_SHEET_ROWS) {
        truncated = true;
        range.e.r = range.s.r + MAX_SHEET_ROWS - 1;
        ws["!ref"] = XLSX.utils.encode_range(range);
      }
    }
    return { name, html: extractTable(XLSX.utils.sheet_to_html(ws)), truncated };
  });
}
