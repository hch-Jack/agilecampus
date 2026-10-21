/**
 * 附件下载响应：任务附件（Bearer REST）与消息附件（Bearer REST）共用。
 *
 * 与浏览器 session 版下载路由保持同一套安全头：
 * 恒为 attachment（防 HTML/SVG 内联 XSS）、nosniff、RFC 5987 文件名。
 */
export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

export function attachmentFileResponse(att: {
  filename: string;
  mimeType: string | null;
  size: number;
  data: Uint8Array;
}): Response {
  // Buffer 不入 BodyInit 类型（TS 5.7 泛型 Uint8Array 亦不兼容 BufferSource），
  // 拷一份纯 ArrayBuffer 视图。
  const body = Uint8Array.from(att.data);
  return new Response(body, {
    headers: {
      "Content-Type": att.mimeType ?? "application/octet-stream",
      "Content-Length": String(att.size),
      "Content-Disposition": contentDisposition(att.filename),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
