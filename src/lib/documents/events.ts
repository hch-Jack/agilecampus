import type { DocumentEvent, PresenceUser } from "./types";

/**
 * 进程内文档事件总线（SSE 的房间）。
 *
 * 单进程 standalone 部署下足够：连接建立/断开即增删 presence，
 * 保存/开关/权限事件只广播给本进程内的订阅者。多实例时 presence
 * 与广播不跨实例，但版本冲突仍由数据库乐观锁保证。未来若横向扩展，
 * 可用 Postgres `LISTEN/NOTIFY` 桥接，无需 Redis。
 *
 * 用 globalThis 单例：dev 下 HMR 重新加载模块时，活动 SSE 连接不能丢。
 */

export type Subscriber = {
  id: string;
  userId: string;
  name: string;
  send: (event: DocumentEvent) => void;
  close: () => void;
};

type Bus = Map<string, Set<Subscriber>>;

const GLOBAL_KEY = Symbol.for("agilecampus.documentEventBus");
const globalForBus = globalThis as unknown as { [GLOBAL_KEY]?: Bus };

function bus(): Bus {
  return (globalForBus[GLOBAL_KEY] ??= new Map());
}

export function subscribe(documentId: string, sub: Subscriber): () => void {
  const rooms = bus();
  let room = rooms.get(documentId);
  if (!room) {
    room = new Set();
    rooms.set(documentId, room);
  }
  room.add(sub);
  return () => {
    const current = rooms.get(documentId);
    if (!current) return;
    current.delete(sub);
    if (current.size === 0) rooms.delete(documentId);
  };
}

export function broadcast(documentId: string, event: DocumentEvent): void {
  const room = bus().get(documentId);
  if (!room) return;
  for (const sub of [...room]) {
    try {
      sub.send(event);
    } catch {
      // 发送失败说明连接已断；由 SSE route 的清理逻辑负责退订
    }
  }
}

/** 在线成员：同一用户多标签页只出现一次 */
export function presence(documentId: string): PresenceUser[] {
  const room = bus().get(documentId);
  if (!room) return [];
  const seen = new Map<string, PresenceUser>();
  for (const sub of room) {
    if (!seen.has(sub.userId)) seen.set(sub.userId, { userId: sub.userId, name: sub.name });
  }
  return [...seen.values()];
}

export function broadcastPresence(documentId: string): void {
  broadcast(documentId, { type: "presence", users: presence(documentId) });
}

/** 仅测试用：清空所有房间 */
export function __resetDocumentBusForTests(): void {
  bus().clear();
}
