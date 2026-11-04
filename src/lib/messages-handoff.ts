/**
 * 消息系统两种模式（整页 ⇄ 浮窗）切换时的会话接力。
 *
 * 两种模式各是一份 MessagesClient 实例，切换/跳转时旧实例卸载、新实例挂载。
 * 这里用 sessionStorage 把「要打开的会话」递给新实例，用户感知是同一个消息系统换了个壳。
 * key 用完即删：普通进页/开浮窗没有 key，落在会话列表空态。
 *
 * 这个文件不能 import 服务端模块：messages-client 与 layout 里的 MessagesPanelShell 都要用。
 */

export const MESSAGES_MODE_HANDOFF_KEY = "ac_messages_mode_handoff";

export type MessagesModeHandoff =
  | { kind: "dm" | "group"; id: string; /** 深链 ?msg= 带的定位消息，可省 */ messageId?: string }
  | { kind: "system" };

export function writeMessagesHandoff(handoff: MessagesModeHandoff | null): void {
  try {
    if (!handoff) {
      sessionStorage.removeItem(MESSAGES_MODE_HANDOFF_KEY);
      return;
    }
    sessionStorage.setItem(MESSAGES_MODE_HANDOFF_KEY, JSON.stringify(handoff));
  } catch {
    // 隐私模式等存不了就算了，切过去落在会话列表而已
  }
}

/** 读一次并删掉：接力只消费一次 */
export function readMessagesHandoff(): MessagesModeHandoff | null {
  try {
    const raw = sessionStorage.getItem(MESSAGES_MODE_HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MESSAGES_MODE_HANDOFF_KEY);
    const v = JSON.parse(raw) as MessagesModeHandoff;
    if (v.kind === "system") return v;
    if ((v.kind === "dm" || v.kind === "group") && typeof v.id === "string") {
      return { kind: v.kind, id: v.id, messageId: v.messageId || undefined };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 /messages 的 URL 参数解析接力目标（浮窗模式下深链落到浮窗用）：
 * `?dm=<peerId>&msg=<id>` / `?group=<id>&msg=<id>` / `?system=1`，与消息页 page.tsx 同一套参数。
 * 这里不做 UUID/权限校验——消费方只会去自己的会话列表里找，找不到就放弃。
 */
export function handoffFromMessagesSearch(search: string): MessagesModeHandoff | null {
  const sp = new URLSearchParams(search);
  const messageId = sp.get("msg") ?? undefined;
  const dm = sp.get("dm");
  if (dm) return { kind: "dm", id: dm, messageId };
  const group = sp.get("group");
  if (group) return { kind: "group", id: group, messageId };
  if (sp.get("system") === "1") return { kind: "system" };
  return null;
}
