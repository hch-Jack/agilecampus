"use client";

/**
 * docx → 可编辑富文本 HTML（仅浏览器）。
 *
 * mammoth 输出语义 HTML，再做一层白名单净化：只保留 Tiptap 能安全解析的
 * 结构，去掉样式/类/id/事件属性与伪协议链接。复杂 Word 排版不在能力内，
 * 编辑页会常驻提示可能丢失的内容。
 */

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "ul", "ol", "li", "strong", "b", "em", "i", "u", "s", "del",
  "code", "pre", "blockquote", "table", "thead", "tbody", "tr", "th", "td",
  "a", "img", "br", "hr",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

export function sanitizeEditorHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");

  for (const el of [...parsed.body.querySelectorAll("*")]) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // 不认识的容器直接拆掉、保留子节点（避免整段文字消失）
      el.replaceWith(...Array.from(el.childNodes));
      continue;
    }
    const allowed = ALLOWED_ATTRS[tag] ?? new Set<string>();
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (!allowed.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      const value = attr.value.trim();
      if (name === "href" && !/^(https?:|mailto:)/i.test(value)) {
        el.removeAttribute(attr.name);
      }
      if (name === "src" && !/^data:image\/(png|jpe?g|gif|bmp|webp);base64,/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return parsed.body.innerHTML;
}

export async function importDocxToHtml(buf: ArrayBuffer): Promise<string> {
  const office = await import("@/lib/file-preview-office");
  const html = await office.docxToHtml(buf);
  return sanitizeEditorHtml(html);
}
