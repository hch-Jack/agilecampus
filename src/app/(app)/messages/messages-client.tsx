"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IdentityBadge } from "@/components/badges";
// 类型从 lib 走 `import type`（编译期擦除），不经 "use server" 的 actions 文件中转
import type { DmConversation, DmMessageView, DmPeer } from "@/lib/dm";
import {
  getConversationsAction,
  openConversationAction,
  searchAddUserAction,
  sendMessageAction,
} from "./actions";

// 单文件上限与 lib/dm.ts 的 DM_ATTACHMENT_MAX_SIZE 一致，客户端先拦一道省一次往返
const FILE_MAX_SIZE = 10 * 1024 * 1024;
const POLL_MS = 4000;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date().toDateString()) return hm;
  return `${d.getMonth() + 1}-${d.getDate()} ${hm}`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Avatar({ name, className = "" }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full bg-primary text-sm font-bold text-white ${className}`}
    >
      {name.charAt(0) || "?"}
    </span>
  );
}

export function MessagesClient() {
  const [convs, setConvs] = useState<DmConversation[]>([]);
  const [peer, setPeer] = useState<DmPeer | null>(null);
  const [msgs, setMsgs] = useState<DmMessageView[]>([]);

  // 搜索用户名（错则留在输入框提示重输，对则加入消息列表）
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);

  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 轮询取「当前打开的会话」：ref 由 effect 同步，避免 render 期写 ref
  const peerIdRef = useRef<string | null>(null);

  useEffect(() => {
    peerIdRef.current = peer?.id ?? null;
  }, [peer?.id]);

  const refreshConvs = useCallback(async () => {
    try {
      const r = await getConversationsAction();
      if (r.ok) setConvs(r.data);
    } catch {
      // 轮询失败静默，下一轮再试
    }
  }, []);

  // 全量拉会话内消息（顺带把未读置为已读）。换人时先清空，避免闪现上一个人的消息。
  const refreshMsgs = useCallback(
    async (peerId: string) => {
      try {
        const r = await openConversationAction(peerId);
        if (r.ok && peerIdRef.current === peerId) setMsgs(r.data.messages);
      } catch {
        // 同上
      }
    },
    [],
  );

  // 轮询：会话列表与当前会话每 4s 刷新，双方消息互通无需手动刷新页面
  useEffect(() => {
    const tick = async () => {
      await refreshConvs();
      const p = peerIdRef.current;
      if (p) await refreshMsgs(p);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshConvs, refreshMsgs]);

  // 消息变化 / 换人时滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, peer?.id]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (searching) return;
    setSearching(true);
    const r = await searchAddUserAction(query).catch(
      (): { ok: false; error: string } => ({ ok: false, error: "网络异常，请稍后再试" }),
    );
    setSearching(false);
    if (!r.ok) {
      // 未命中：保留输入，提示重新输入
      setSearchError(r.error);
      return;
    }
    setSearchError("");
    setQuery("");
    setPeer(r.data);
    // ref 在 effect 里同步会晚一拍，这里直接写上，让紧随其后的 refreshMsgs 守卫放行
    peerIdRef.current = r.data.id;
    setMsgs([]);
    await refreshMsgs(r.data.id);
    refreshConvs();
  }

  function selectPeer(c: DmConversation) {
    setPeer({ id: c.peerId, name: c.peerName, identity: c.identity });
    peerIdRef.current = c.peerId;
    setMsgs([]);
    setSendError("");
    refreshMsgs(c.peerId);
    // 打开即清掉本地角标；服务端已由 refreshMsgs 的置读兜底
    setConvs((prev) => prev.map((v) => (v.peerId === c.peerId ? { ...v, unread: 0 } : v)));
    refreshConvs();
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!peer || sending) return;
    const content = draft.trim();
    if (!content && !file) return;
    if (file && file.size > FILE_MAX_SIZE) {
      setSendError("文件不能超过 10MB");
      return;
    }
    setSending(true);
    setSendError("");
    const fd = new FormData();
    fd.set("content", content);
    if (file) fd.set("file", file);
    const r = await sendMessageAction(peer.id, fd).catch(
      (): { ok: false; error: string } => ({ ok: false, error: "网络异常，请稍后再试" }),
    );
    setSending(false);
    if (!r.ok) {
      setSendError(r.error);
      return;
    }
    setDraft("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setMsgs(r.data.messages);
    refreshConvs();
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setSendError(f && f.size > FILE_MAX_SIZE ? "文件不能超过 10MB" : "");
    setFile(f);
  }

  return (
    <div className="grid h-[72vh] min-h-[480px] grid-cols-1 overflow-hidden rounded-field border border-line bg-surface sm:grid-cols-[280px_1fr]">
      {/* 左栏：搜索 + 消息列表 */}
      <aside
        className={`flex-col border-r border-line ${peer ? "hidden sm:flex" : "flex"}`}
      >
        <form onSubmit={handleSearch} className="border-b border-line p-3">
          <div className="flex gap-2">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSearchError("");
              }}
              placeholder="搜用户名，找人开聊"
              className="min-w-0 flex-1 rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
              aria-label="搜索用户名"
            />
            <button type="submit" disabled={searching || !query.trim()} className="ac-btn px-3 py-1.5 text-sm">
              {searching ? "…" : "搜索"}
            </button>
          </div>
          {searchError && <p className="mt-2 text-xs text-high">{searchError}</p>}
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {convs.length === 0 ? (
            <p className="p-4 text-sm text-ink-faint">还没有会话。上方搜索对方 用户名 并回车，即可加入消息列表。</p>
          ) : (
            <ul>
              {convs.map((c) => (
                <li key={c.peerId}>
                  <button
                    type="button"
                    onClick={() => selectPeer(c)}
                    className={`flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
                      peer?.id === c.peerId ? "bg-primary-soft" : "hover:bg-sunken"
                    }`}
                  >
                    <Avatar name={c.peerName} className="h-10 w-10 text-base" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium text-ink">{c.peerName}</span>
                        <IdentityBadge identity={c.identity} className="scale-90" />
                      </span>
                      <span className="block truncate text-xs text-ink-faint">
                        {c.preview ? `${c.lastMine ? "我：" : ""}${c.preview}` : "打个招呼吧"}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      {c.lastAt && <span className="text-[11px] text-ink-faint">{fmtTime(c.lastAt)}</span>}
                      {c.unread > 0 && (
                        <span className="grid h-5 min-w-5 place-items-center rounded-full bg-high px-1.5 text-[11px] font-bold text-white">
                          {c.unread > 99 ? "99+" : c.unread}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* 右栏：聊天窗口 */}
      <section className={`min-h-0 flex-col ${peer ? "flex" : "hidden sm:flex"}`}>
        {!peer ? (
          <div className="grid flex-1 place-items-center text-sm text-ink-faint">
            选择左侧会话，或搜索用户名开始聊天
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 border-b border-line px-4 py-3">
              <button
                type="button"
                onClick={() => setPeer(null)}
                className="text-sm text-ink-soft hover:text-primary sm:hidden"
                aria-label="返回消息列表"
              >
                ←
              </button>
              <Avatar name={peer.name} className="h-8 w-8" />
              <span className="text-sm font-semibold text-ink">{peer.name}</span>
              <IdentityBadge identity={peer.identity} />
              <span className="ml-auto text-xs text-ink-faint">消息自动留存</span>
            </header>

            <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {msgs.length === 0 && (
                <p className="pt-8 text-center text-xs text-ink-faint">
                  还没有消息，发送第一条吧（支持传文件，单个 ≤ 10MB）
                </p>
              )}
              {msgs.map((m) => (
                <div key={m.id} className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[75%] ${m.mine ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
                    <div
                      className={`break-words rounded-2xl px-3.5 py-2 text-sm ${
                        m.mine
                          ? "rounded-br-sm bg-primary text-white"
                          : "rounded-bl-sm border border-line bg-sunken text-ink"
                      }`}
                    >
                      {m.content && <p className="whitespace-pre-wrap">{m.content}</p>}
                      {m.attachment && (
                        <a
                          href={`/api/dm/attachments/${m.attachment.id}`}
                          className={`mt-1 flex items-center gap-1.5 rounded-field px-2 py-1.5 text-xs underline-offset-2 hover:underline ${
                            m.mine ? "bg-primary-hover text-white" : "bg-surface text-primary"
                          }`}
                          download
                        >
                          <span aria-hidden>📄</span>
                          <span className="max-w-48 truncate">{m.attachment.filename}</span>
                          <span className={m.mine ? "text-white/70" : "text-ink-faint"}>
                            {fmtSize(m.attachment.size)}
                          </span>
                        </a>
                      )}
                    </div>
                    <span className="px-1 text-[11px] text-ink-faint">
                      {fmtTime(m.createdAt)}
                      {m.mine && (m.readAt ? " · 已读" : " · 未读")}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleSend} className="border-t border-line p-3">
              {file && (
                <p className="mb-2 flex items-center gap-2 rounded-field bg-sunken px-2.5 py-1.5 text-xs text-ink-soft">
                  <span aria-hidden>📄</span>
                  <span className="min-w-0 flex-1 truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="text-ink-faint hover:text-high"
                    aria-label="移除附件"
                  >
                    ×
                  </button>
                </p>
              )}
              {sendError && <p className="mb-2 text-xs text-high">{sendError}</p>}
              <div className="flex items-end gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={pickFile}
                  aria-label="选择文件"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="ac-btn-ghost px-2.5 py-2 text-sm"
                  title="传文件（≤10MB）"
                >
                  📎
                </button>
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 发送，Shift+Enter 换行——QQ 同款习惯
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={1}
                  placeholder={`发消息给 ${peer.name}…`}
                  className="max-h-32 min-h-9 flex-1 resize-none rounded-field border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                  aria-label="消息内容"
                />
                <button type="submit" disabled={sending || (!draft.trim() && !file)} className="ac-btn px-4 py-2 text-sm">
                  {sending ? "发送中…" : "发送"}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
