/**
 * 从 pathname 里认出「用户正看着哪个项目」。
 *
 * 右侧助手面板要在任意页面判断自己是否处在项目上下文里，但服务端 layout 拿不到 pathname，
 * 只能在客户端用 `usePathname()` 推。这里用**严格 uuid** 匹配：
 * 把 `/projects/foo` 之类的非法 id 发给 `/api/chat` 只会换回 400，
 * 与其让用户看到一句「缺少项目 id」，不如当作没有项目上下文。
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function projectIdFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const m = /^\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m || !UUID_RE.test(m[1])) return null;
  return m[1];
}
