/**
 * 浏览器只有在「安全上下文」（HTTPS 或 localhost）才提供
 * `crypto.randomUUID()` 与 `crypto.subtle`。
 *
 * 这套系统按设计会在局域网里用 `http://<内网 IP>:3000` 打开。此时：
 * - SuperDoc 用 `crypto.subtle.digest("SHA-256", …)` 给字体/文档算指纹 →
 *   报 "Cannot read properties of undefined (reading 'digest')"；
 * - BetterOffice 用 `crypto.randomUUID()` 建会话 →
 *   报 "crypto.randomUUID is not a function"。
 *
 * 这两个 API 在不安全上下文里用纯 JS 补齐即可（不涉及真正的加密安全需求：
 * SuperDoc 只用来做内容去重，BetterOffice 只用来生成会话 ID）。
 * `crypto.getRandomValues` 在不安全上下文仍可用，UUID 用它生成；
 * SHA-256 用 js-sha256。
 */
import { sha256 } from "js-sha256";

function install(): void {
  if (typeof window === "undefined") return;
  const c = window.crypto;
  if (!c) return;

  if (typeof c.randomUUID !== "function") {
    const randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
      const bytes = new Uint8Array(16);
      c.getRandomValues(bytes);
      // RFC 4122 v4
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
        16,
        20,
      )}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
    };
    try {
      Object.defineProperty(c, "randomUUID", { configurable: true, value: randomUUID });
    } catch {
      // 极少数浏览器把属性设成不可配置：忽略，后续调用仍会失败
    }
  }

  if (!c.subtle || typeof c.subtle.digest !== "function") {
    const digest = async (
      algorithm: AlgorithmIdentifier,
      data: BufferSource,
    ): Promise<ArrayBuffer> => {
      const name =
        typeof algorithm === "string" ? algorithm : (algorithm?.name ?? "");
      if (name.toUpperCase() !== "SHA-256") {
        throw new Error(`不支持的摘要算法（非安全上下文）：${name}`);
      }
      const bytes =
        data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      return sha256.arrayBuffer(bytes);
    };
    const subtle = { digest } as unknown as SubtleCrypto;
    try {
      Object.defineProperty(c, "subtle", { configurable: true, value: subtle });
    } catch {
      try {
        (c as { subtle?: SubtleCrypto }).subtle = subtle;
      } catch {
        // 同 randomUUID：无法覆盖时保持原样
      }
    }
  }
}

install();

export {};
