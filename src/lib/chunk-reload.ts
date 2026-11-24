/**
 * 部署后旧标签页里的 chunk 已经不存在时，动态 import 会抛
 * 「Failed to fetch dynamically imported module / ChunkLoadError」。
 * 这时自动整页刷新一次即可拿到新构建；用 sessionStorage 防止无限刷新。
 */
const FLAG = "ac:chunk-reload";

export function isChunkLoadError(e: unknown): boolean {
  const text = e instanceof Error ? `${e.name} ${e.message}` : String(e ?? "");
  return /ChunkLoadError|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(
    text,
  );
}

/** 命中 chunk 失效时刷新一次并返回 true；调用方应直接 return */
export function reloadOnceForChunkError(e: unknown): boolean {
  if (typeof window === "undefined" || !isChunkLoadError(e)) return false;
  try {
    if (window.sessionStorage.getItem(FLAG)) return false;
    window.sessionStorage.setItem(FLAG, "1");
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** 编辑器成功加载后清掉标记，下次部署仍能自动刷新 */
export function clearChunkReloadFlag(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(FLAG);
  } catch {
    // 隐私模式下不可用，忽略
  }
}
