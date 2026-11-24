import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { blobPath, blobReadStream } from "./blob-store";

/**
 * 附件下载响应：任务附件、消息附件、助手对话文件共用。
 *
 * 与浏览器 session 版下载路由保持同一套安全头：
 * 恒为 attachment（防 HTML/SVG 内联 XSS）、nosniff、RFC 5987 文件名。
 * 正文在磁盘上的（`storageKey`）直接流式返回，不整份读进内存；历史附件仍从库里的
 * `data` 列拷贝一份 ArrayBuffer 视图。
 */

export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename*=UTF-8''${encoded}`;
}

export function attachmentFileResponse(
  att: {
    filename: string;
    mimeType: string | null;
    size: number;
    data?: Uint8Array | null;
    storageKey?: string | null;
  },
  opts?: { mimeType?: string | null },
): Response {
  const headers = {
    "Content-Type": opts?.mimeType ?? att.mimeType ?? "application/octet-stream",
    "Content-Length": String(att.size),
    "Content-Disposition": contentDisposition(att.filename),
    "X-Content-Type-Options": "nosniff",
  };

  if (att.storageKey) {
    // 先确认落盘文件还在：缺失时如果照常回 200 + Content-Length 再让流报错，
    // 浏览器只能看到「下载失败 / 网络错误」，预览也只会拿到半截。宁可回一个明确的 404。
    let file: string | null = null;
    try {
      file = blobPath(att.storageKey);
    } catch {
      // 非法 key 与文件不存在同样处理
    }
    if (!file || !existsSync(file)) {
      return new Response("文件内容已丢失，请重新上传", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    const stream = Readable.toWeb(blobReadStream(att.storageKey)) as unknown as ReadableStream;
    return new Response(stream, { headers });
  }

  // Buffer 不入 BodyInit 类型（TS 5.7 泛型 Uint8Array 亦不兼容 BufferSource），
  // 拷一份纯 ArrayBuffer 视图。
  const body = Uint8Array.from(att.data ?? []);
  return new Response(body, { headers });
}
