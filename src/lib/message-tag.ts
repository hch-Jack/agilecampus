/**
 * 助手消息标签的命名规则 —— **客户端安全**，面板输入框与服务端校验共用。
 *
 * 和会话分类名同一套「短标签」讲究：去首尾空白、控制字符转空格、连续空白折叠、
 * 按码点截到 20 字。空串一律视为没有标签。
 */

export const MESSAGE_TAG_MAX = 20;

export function normalizeMessageTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // 控制字符（含换行/制表）换成空格再折叠 —— 直接删掉会让前后两截粘成一个词
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  const chars = Array.from(cleaned);
  return chars.length > MESSAGE_TAG_MAX ? chars.slice(0, MESSAGE_TAG_MAX).join("") : cleaned;
}
