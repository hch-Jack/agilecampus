import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetDocumentBusForTests,
  broadcast,
  broadcastPresence,
  presence,
  subscribe,
  type Subscriber,
} from "@/lib/documents/events";
import type { DocumentEvent } from "@/lib/documents/types";

const DOC = "doc-1";

function makeSub(userId: string, name: string, sink: DocumentEvent[]): Subscriber {
  return {
    id: `${userId}-${Math.random()}`,
    userId,
    name,
    send: (event) => sink.push(event),
    close: () => {},
  };
}

beforeEach(() => __resetDocumentBusForTests());

describe("进程内文档事件总线", () => {
  it("广播只发给同文档的订阅者", () => {
    const hits: DocumentEvent[] = [];
    const other: DocumentEvent[] = [];
    subscribe(DOC, makeSub("u1", "甲", hits));
    subscribe("doc-2", makeSub("u2", "乙", other));

    broadcast(DOC, { type: "settings", collaborationEnabled: true, actorId: "u1" });
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("settings");
    expect(other).toHaveLength(0);
  });

  it("presence 按 userId 去重（同一用户多标签页只出现一次）", () => {
    subscribe(DOC, makeSub("u1", "甲", []));
    subscribe(DOC, makeSub("u1", "甲", []));
    subscribe(DOC, makeSub("u2", "乙", []));

    const users = presence(DOC);
    expect(users).toHaveLength(2);
    expect(users.map((u) => u.userId).sort()).toEqual(["u1", "u2"]);
  });

  it("取消订阅后不再收到事件；重复取消不报错", () => {
    const hits: DocumentEvent[] = [];
    const off = subscribe(DOC, makeSub("u1", "甲", hits));
    off();
    off();
    broadcast(DOC, { type: "lock", lock: null });
    expect(hits).toHaveLength(0);
    expect(presence(DOC)).toEqual([]);
  });

  it("单个订阅者抛错不影响其他订阅者", () => {
    const hits: DocumentEvent[] = [];
    subscribe(DOC, {
      id: "bad",
      userId: "bad",
      name: "坏连接",
      send: () => {
        throw new Error("连接已断");
      },
      close: () => {},
    });
    subscribe(DOC, makeSub("u1", "甲", hits));

    expect(() => broadcast(DOC, { type: "lock", lock: null })).not.toThrow();
    expect(hits).toHaveLength(1);
  });

  it("broadcastPresence 推当前在线名单", () => {
    const hits: DocumentEvent[] = [];
    subscribe(DOC, makeSub("u1", "甲", hits));
    subscribe(DOC, makeSub("u2", "乙", []));

    broadcastPresence(DOC);
    const event = hits.find((e) => e.type === "presence");
    expect(event).toMatchObject({ type: "presence" });
    if (event?.type === "presence") {
      expect(event.users.map((u) => u.userId).sort()).toEqual(["u1", "u2"]);
    }
  });

  it("没有房间时广播是空操作", () => {
    expect(() =>
      broadcast("missing", { type: "lock", lock: null }),
    ).not.toThrow();
    expect(presence("missing")).toEqual([]);
  });
});
