"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IdentityBadge } from "@/components/badges";
// 类型从 lib 走 `import type`（编译期擦除），不经 "use server" 的 actions 文件中转
import type { DmConversation, DmMessageView, DmPeer } from "@/lib/dm";
import type {
  GroupConversation,
  GroupInfo,
  GroupInviteView,
  GroupMessageView,
  UnifiedConversation,
} from "@/lib/group-chat";
import { dateIn, formatClockTime, formatShortDateTime, todayIn } from "@/lib/time";
import {
  createGroupAction,
  dissolveGroupAction,
  findUserForGroupAction,
  getConversationsAction,
  inviteToGroupAction,
  kickMemberAction,
  leaveGroupAction,
  listMyGroupInvitesAction,
  openConversationAction,
  openGroupConversationAction,
  respondToGroupInviteAction,
  searchAddUserAction,
  sendGroupMessageAction,
  sendMessageAction,
} from "./actions";

// 单文件上限与 lib/dm.ts 的 DM_ATTACHMENT_MAX_SIZE 一致，客户端先拦一道省一次往返
const FILE_MAX_SIZE = 10 * 1024 * 1024;
const POLL_MS = 4000;

// 时间按**用户设置的时区**显示，不看浏览器本地时区 —— 选了中国时间的人身在国外时，
// 浏览器本地的「今天」与站内其他页面的「今天」会对不上（全站口径见 lib/time.ts）。
function fmtTime(tz: string, iso: string): string {
  const d = new Date(iso);
  if (dateIn(tz, d) === todayIn(tz)) return formatClockTime(tz, d);
  return formatShortDateTime(tz, d);
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function Avatar({
  name,
  url,
  className = "",
}: {
  name: string;
  url?: string | null;
  className?: string;
}) {
  // 对方传过头像就显图片（换头像后 URL 的 ?v= 版本号会变，4s 轮询自动带出新的）。
  // 头像是 <2MB 的本地小图且按版本号寻址长缓存，next/image 优化器帮不上忙。
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt=""
        className={`shrink-0 rounded-full border border-line object-cover ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={`grid shrink-0 place-items-center rounded-full bg-primary text-sm font-bold text-white ${className}`}
    >
      {name.charAt(0) || "?"}
    </span>
  );
}

// 未读红点（会话行 / 邀请区共用）：bg-danger 微信红，99+ 封顶
function UnreadBadge({ count }: { count: number }) {
  return (
    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1.5 text-[11px] font-bold text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

function AttachmentLink({
  att,
  mine,
}: {
  att: { id: string; filename: string; size: number };
  mine: boolean;
}) {
  return (
    <a
      href={`/api/dm/attachments/${att.id}`}
      className={`mt-1 flex items-center gap-1.5 rounded-field px-2 py-1.5 text-xs underline-offset-2 hover:underline ${
        mine ? "bg-primary-hover text-white" : "bg-surface text-primary"
      }`}
      download
    >
      <span aria-hidden>📄</span>
      <span className="max-w-48 truncate">{att.filename}</span>
      <span className={mine ? "text-white/70" : "text-ink-faint"}>{fmtSize(att.size)}</span>
    </a>
  );
}

// 群聊气泡：他人消息气泡上方标发送人名；群聊无已读回执，时间行不带 已读/未读
function GroupBubble({ m, tz }: { m: GroupMessageView; tz: string }) {
  return (
    <div className={`flex ${m.mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[75%] ${m.mine ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
        {!m.mine && <span className="px-1 text-[11px] text-ink-faint">{m.senderName}</span>}
        <div
          className={`break-words rounded-2xl px-3.5 py-2 text-sm ${
            m.mine
              ? "rounded-br-sm bg-primary text-white"
              : "rounded-bl-sm border border-line bg-sunken text-ink"
          }`}
        >
          {m.content && <p className="whitespace-pre-wrap">{m.content}</p>}
          {m.attachment && <AttachmentLink att={m.attachment} mine={m.mine} />}
        </div>
        <span className="px-1 text-[11px] text-ink-faint">{fmtTime(tz, m.createdAt)}</span>
      </div>
    </div>
  );
}

type Selection = { kind: "dm" | "group"; id: string } | null;

// 网络异常兜底文案：action 抛的非 AppError（网络断、序列化失败等）统一落到这里
const NET_FAIL = (): { ok: false; error: string } => ({ ok: false, error: "网络异常，请稍后再试" });

export function MessagesClient({ timeZone }: { timeZone: string }) {
  // 统一会话列表（私信 + 群聊混排）与群邀请
  const [convs, setConvs] = useState<UnifiedConversation[]>([]);
  const [invites, setInvites] = useState<GroupInviteView[]>([]);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  // 当前打开的会话；peer 是私信头部，group 是群头部（每次轮询整包替换，成员条自动纠偏）
  const [selection, setSelection] = useState<Selection>(null);
  const [peer, setPeer] = useState<DmPeer | null>(null);
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [msgs, setMsgs] = useState<(DmMessageView | GroupMessageView)[]>([]);
  // 一次性提示横幅（被移出群聊、群已解散、邀请处理异常等）
  const [notice, setNotice] = useState("");

  // 私信：搜索用户名（错则留在输入框提示重输，对则加入消息列表）
  const [query, setQuery] = useState("");
  const [searchError, setSearchError] = useState("");
  const [searching, setSearching] = useState(false);

  // 建群面板：群名 + 候选成员（用户名搜索添加 + 从私信会话勾选）
  const [newName, setNewName] = useState("");
  const [picked, setPicked] = useState<DmPeer[]>([]);
  const [pickQuery, setPickQuery] = useState("");
  const [pickError, setPickError] = useState("");
  const [picking, setPicking] = useState(false);
  const [creating, setCreating] = useState(false);

  // 群成员条：邀请输入 + 踢人/退群/解散
  const [membersOpen, setMembersOpen] = useState(false);
  const [inviteName, setInviteName] = useState("");
  const [inviteError, setInviteError] = useState("");
  const [inviteHint, setInviteHint] = useState("");
  const [inviting, setInviting] = useState(false);
  const [groupOpBusy, setGroupOpBusy] = useState(false);
  const [groupOpError, setGroupOpError] = useState("");
  const [responding, setResponding] = useState(false); // 正在处理某条邀请

  const [draft, setDraft] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sendError, setSendError] = useState("");
  const [sending, setSending] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // 轮询取「当前打开的会话」：ref 由 effect 与选中动作同步，回调据此丢弃陈旧响应
  const activeRef = useRef<Selection>(null);

  useEffect(() => {
    activeRef.current = selection;
  }, [selection]);

  const refreshConvs = useCallback(async () => {
    try {
      const r = await getConversationsAction();
      if (r.ok) setConvs(r.data);
    } catch {
      // 轮询失败静默，下一轮再试
    }
  }, []);

  const refreshInvites = useCallback(async () => {
    try {
      const r = await listMyGroupInvitesAction();
      if (r.ok) setInvites(r.data);
    } catch {
      // 同上
    }
  }, []);

  // 全量拉私信（顺带把未读置为已读）。换人时先清空，避免闪现上一个人的消息。
  const refreshDmMsgs = useCallback(async (id: string) => {
    try {
      const r = await openConversationAction(id);
      const a = activeRef.current;
      if (r.ok && a?.kind === "dm" && a.id === id) setMsgs(r.data.messages);
    } catch {
      // 同上
    }
  }, []);

  // 全量拉群消息（顺带把未读基线推到当前）。!ok 视为被移出/群解散：
  // 关掉面板并提示一次 —— 主动退群/解散会先清 selection，走不到这个分支，不会误报。
  const refreshGroupMsgs = useCallback(
    async (id: string) => {
      try {
        const r = await openGroupConversationAction(id);
        const a = activeRef.current;
        if (a?.kind !== "group" || a.id !== id) return; // 已切走，丢弃陈旧响应
        if (r.ok) {
          setGroup(r.data.group);
          setMsgs(r.data.messages);
        } else {
          setSelection(null);
          activeRef.current = null;
          setPeer(null);
          setGroup(null);
          setMsgs([]);
          setMembersOpen(false);
          setNotice(r.error);
          refreshConvs();
        }
      } catch {
        // 轮询失败静默，下一轮再试
      }
    },
    [refreshConvs],
  );

  // 轮询：统一列表、邀请、当前会话每 4s 刷新，双方/群内消息互通无需手动刷新页面
  useEffect(() => {
    const tick = async () => {
      await refreshConvs();
      await refreshInvites();
      const a = activeRef.current;
      if (a?.kind === "dm") await refreshDmMsgs(a.id);
      else if (a?.kind === "group") await refreshGroupMsgs(a.id);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [refreshConvs, refreshInvites, refreshDmMsgs, refreshGroupMsgs]);

  // 消息变化 / 换会话时滚到底部
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, selection]);

  function openDm(id: string, p: DmPeer) {
    setCreateOpen(false);
    setSelection({ kind: "dm", id });
    activeRef.current = { kind: "dm", id };
    setPeer(p);
    setGroup(null);
    setMembersOpen(false);
    setMsgs([]);
    setSendError("");
    refreshDmMsgs(id);
  }

  function openGroup(id: string) {
    setCreateOpen(false);
    setSelection({ kind: "group", id });
    activeRef.current = { kind: "group", id };
    setPeer(null);
    setGroup(null);
    setMembersOpen(false);
    setMsgs([]);
    setSendError("");
    refreshGroupMsgs(id);
  }

  function closePane() {
    setSelection(null);
    activeRef.current = null;
    setPeer(null);
    setGroup(null);
    setMsgs([]);
    setMembersOpen(false);
  }

  function selectDm(c: DmConversation) {
    openDm(c.peerId, {
      id: c.peerId,
      name: c.peerName,
      identity: c.identity,
      avatarUrl: c.peerAvatarUrl,
    });
    // 打开即清掉本地角标；服务端已由 refreshDmMsgs 的置读兜底
    setConvs((prev) =>
      prev.map((v) => (v.kind === "dm" && v.peerId === c.peerId ? { ...v, unread: 0 } : v)),
    );
    refreshConvs();
  }

  function selectGroup(c: GroupConversation) {
    openGroup(c.groupId);
    setConvs((prev) =>
      prev.map((v) => (v.kind === "group" && v.groupId === c.groupId ? { ...v, unread: 0 } : v)),
    );
    refreshConvs();
  }

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (searching) return;
    setSearching(true);
    const r = await searchAddUserAction(query).catch(NET_FAIL);
    setSearching(false);
    if (!r.ok) {
      // 未命中：保留输入，提示重新输入
      setSearchError(r.error);
      return;
    }
    setSearchError("");
    setQuery("");
    openDm(r.data.id, r.data);
    refreshConvs();
  }

  // —— 建群面板 ——

  async function addPick() {
    if (picking || !pickQuery.trim()) return;
    setPicking(true);
    const r = await findUserForGroupAction(pickQuery).catch(NET_FAIL);
    setPicking(false);
    if (!r.ok) {
      setPickError(r.error);
      return;
    }
    if (picked.some((p) => p.id === r.data.id)) {
      setPickError("TA 已在候选列表");
      return;
    }
    setPickError("");
    setPickQuery("");
    setPicked((prev) => [...prev, r.data]);
  }

  function togglePick(p: DmPeer) {
    setPicked((prev) =>
      prev.some((x) => x.id === p.id) ? prev.filter((x) => x.id !== p.id) : [...prev, p],
    );
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating) return;
    setCreating(true);
    const r = await createGroupAction(newName.trim(), picked.map((p) => p.id)).catch(NET_FAIL);
    setCreating(false);
    if (!r.ok) {
      setPickError(r.error);
      return;
    }
    setNewName("");
    setPicked([]);
    setPickQuery("");
    setPickError("");
    openGroup(r.data.id);
    setGroup(r.data); // createGroupAction 已回全量 GroupInfo，先铺上再等轮询补消息
    refreshConvs();
  }

  // —— 群邀请 ——

  async function respondInvite(v: GroupInviteView, accept: boolean) {
    if (responding) return;
    setResponding(true);
    const r = await respondToGroupInviteAction(v.inviteId, accept).catch(NET_FAIL);
    setResponding(false);
    if (!r.ok) {
      setNotice(r.error);
      refreshInvites();
      return;
    }
    setInvites((prev) => prev.filter((x) => x.inviteId !== v.inviteId));
    if (accept) {
      // 接受即进群并打开（refreshGroupMsgs 会拉全量并置已读）
      openGroup(r.data.groupId);
    }
    refreshConvs();
  }

  // —— 群成员条 ——

  async function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!group || inviting) return;
    setInviting(true);
    const r = await inviteToGroupAction(group.id, inviteName).catch(NET_FAIL);
    setInviting(false);
    if (!r.ok) {
      setInviteError(r.error);
      return;
    }
    setInviteError("");
    setInviteName("");
    setInviteHint(`已邀请 ${r.data.inviteeName}，待对方处理`);
  }

  async function handleKick(userId: string, name: string) {
    if (!group || groupOpBusy) return;
    if (!confirm(`确认将 ${name} 移出群聊？`)) return;
    setGroupOpBusy(true);
    setGroupOpError("");
    const r = await kickMemberAction(group.id, userId).catch(NET_FAIL);
    setGroupOpBusy(false);
    if (!r.ok) {
      setGroupOpError(r.error);
      return;
    }
    refreshGroupMsgs(group.id); // 整包替换 GroupInfo，成员条随之更新
    refreshConvs();
  }

  async function handleLeave() {
    if (!group || groupOpBusy) return;
    if (!confirm("退出后需重新被邀请才能进群，确认退群？")) return;
    setGroupOpBusy(true);
    const r = await leaveGroupAction(group.id).catch(NET_FAIL);
    setGroupOpBusy(false);
    if (!r.ok) {
      setGroupOpError(r.error);
      return;
    }
    closePane(); // 先清 selection，轮询不再打这个群，不会触发「已不在群聊」横幅
    refreshConvs();
  }

  async function handleDissolve() {
    if (!group || groupOpBusy) return;
    if (!confirm("解散后消息对所有成员消失，确认解散？")) return;
    setGroupOpBusy(true);
    const r = await dissolveGroupAction(group.id).catch(NET_FAIL);
    setGroupOpBusy(false);
    if (!r.ok) {
      setGroupOpError(r.error);
      return;
    }
    closePane();
    refreshConvs();
  }

  // —— 发送（私信/群聊共用一套表单） ——

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    const a = activeRef.current;
    if (sending || !a) return;
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
    const r = await (a.kind === "dm"
      ? sendMessageAction(a.id, fd)
      : sendGroupMessageAction(a.id, fd)
    ).catch(NET_FAIL);
    setSending(false);
    if (!r.ok) {
      setSendError(r.error);
      return;
    }
    setDraft("");
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    // 两个 action 成功时都回全量，客户端直接整表替换
    setMsgs(r.data.messages);
    if (a.kind === "group" && "group" in r.data) {
      const cur = activeRef.current;
      if (cur?.kind === "group" && cur.id === a.id) setGroup(r.data.group);
    }
    refreshConvs();
  }

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setSendError(f && f.size > FILE_MAX_SIZE ? "文件不能超过 10MB" : "");
    setFile(f);
  }

  // —— 渲染 ——

  const dmRows = convs.filter((c): c is DmConversation & { kind: "dm" } => c.kind === "dm");
  const dmPeers: DmPeer[] = dmRows.map((c) => ({
    id: c.peerId,
    name: c.peerName,
    identity: c.identity,
    avatarUrl: c.peerAvatarUrl,
  }));
  // 建群候选 = 已搜索添加的人（置顶）+ 私信会话里还没勾的人
  const pickCandidates: DmPeer[] = [
    ...picked,
    ...dmPeers.filter((p) => !picked.some((x) => x.id === p.id)),
  ];

  function rowCls(active: boolean) {
    return `flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors ${
      active ? "bg-primary-soft" : "hover:bg-sunken"
    }`;
  }

  const placeholder =
    selection?.kind === "dm" && peer
      ? `发消息给 ${peer.name}…`
      : selection?.kind === "group" && group
        ? `发消息到 ${group.name}…`
        : "";

  const sendForm = (
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
          placeholder={placeholder}
          className="max-h-32 min-h-9 flex-1 resize-none rounded-field border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
          aria-label="消息内容"
        />
        <button type="submit" disabled={sending || (!draft.trim() && !file)} className="ac-btn px-4 py-2 text-sm">
          {sending ? "发送中…" : "发送"}
        </button>
      </div>
    </form>
  );

  return (
    <div className="proj-page-enter">
      {notice && (
        <div className="mb-2 flex items-center justify-between rounded-field border border-line bg-sunken px-3 py-1.5 text-xs text-ink-soft">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice("")}
            className="text-ink-faint hover:text-ink"
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      )}
      <div className="grid h-[72vh] min-h-[480px] grid-cols-1 overflow-hidden rounded-field border border-line bg-surface sm:grid-cols-[280px_1fr]">
        {/* 左栏：搜索 + 建群 + 邀请 + 统一消息列表 */}
        <aside className={`flex-col border-r border-line ${selection ? "hidden sm:flex" : "flex"}`}>
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
            <button
              type="button"
              onClick={() => setCreateOpen((v) => !v)}
              className={`ac-btn-ghost mt-2 w-full justify-center py-1.5 text-sm ${createOpen ? "border-primary text-primary" : ""}`}
            >
              ＋ 发起群聊
            </button>
          </form>

          {createOpen && (
            <form
              onSubmit={handleCreate}
              className="border-b border-line p-3"
            >
              <input
                value={newName}
                onChange={(e) => {
                  setNewName(e.target.value);
                  setPickError("");
                }}
                maxLength={30}
                placeholder="群聊名称"
                className="w-full rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                aria-label="群聊名称"
              />
              <div className="mt-2 flex gap-2">
                <input
                  value={pickQuery}
                  onChange={(e) => {
                    setPickQuery(e.target.value);
                    setPickError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      addPick();
                    }
                  }}
                  placeholder="用户名搜索并添加成员"
                  className="min-w-0 flex-1 rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                  aria-label="搜索要加入群聊的用户名"
                />
                <button
                  type="button"
                  onClick={addPick}
                  disabled={picking || !pickQuery.trim()}
                  className="ac-btn-ghost px-3 py-1.5 text-sm"
                >
                  {picking ? "…" : "添加"}
                </button>
              </div>
              {pickError && <p className="mt-2 text-xs text-high">{pickError}</p>}
              {pickCandidates.length > 0 && (
                <ul className="mt-2 max-h-40 overflow-y-auto">
                  {pickCandidates.map((p) => {
                    const checked = picked.some((x) => x.id === p.id);
                    return (
                      <li key={p.id}>
                        <label className="flex cursor-pointer items-center gap-2 rounded-field px-2 py-1.5 hover:bg-sunken">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => togglePick(p)}
                            className="accent-primary"
                          />
                          <Avatar name={p.name} url={p.avatarUrl} className="h-6 w-6 text-xs" />
                          <span className="min-w-0 flex-1 truncate text-sm text-ink">{p.name}</span>
                          <IdentityBadge identity={p.identity} className="scale-90" />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-1 text-xs text-ink-faint">已选 {picked.length} 人（上限 49）</p>
              <button
                type="submit"
                disabled={creating || !newName.trim()}
                className="ac-btn mt-2 w-full justify-center py-1.5 text-sm"
              >
                {creating ? "创建中…" : "创建群聊"}
              </button>
            </form>
          )}

          {invites.length > 0 && (
            <div className="border-b border-line">
              <button
                type="button"
                onClick={() => setInvitesOpen((v) => !v)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-sunken"
              >
                <span
                  aria-hidden
                  className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-soft text-base"
                >
                  👥
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">群聊邀请</span>
                  <span className="block truncate text-xs text-ink-faint">
                    「{invites[0].groupName}」{invites[0].inviterName} 邀请你进群
                    {invites.length > 1 ? ` 等 ${invites.length} 条` : ""}
                  </span>
                </span>
                {!invitesOpen && <UnreadBadge count={invites.length} />}
              </button>
              {invitesOpen && (
                <ul className="pb-2">
                  {invites.map((v) => (
                    <li key={v.inviteId} className="flex items-center gap-2 py-1.5 pl-14 pr-3">
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-soft">
                        「{v.groupName}」{v.inviterName} 邀请你进群
                      </span>
                      <button
                        type="button"
                        disabled={responding}
                        onClick={() => respondInvite(v, true)}
                        className="ac-btn px-2.5 py-1 text-xs"
                      >
                        进群
                      </button>
                      <button
                        type="button"
                        disabled={responding}
                        onClick={() => respondInvite(v, false)}
                        className="ac-btn-ghost px-2.5 py-1 text-xs"
                      >
                        拒绝
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {convs.length === 0 ? (
              <p className="p-4 text-sm text-ink-faint">
                还没有会话。上方搜索对方 用户名 开聊，或发起群聊。
              </p>
            ) : (
              <ul>
                {convs.map((c) =>
                  c.kind === "dm" ? (
                    <li key={`dm-${c.peerId}`}>
                      <button
                        type="button"
                        onClick={() => selectDm(c)}
                        className={rowCls(selection?.kind === "dm" && selection.id === c.peerId)}
                      >
                        <Avatar name={c.peerName} url={c.peerAvatarUrl} className="h-10 w-10 text-base" />
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
                          {c.lastAt && <span className="text-[11px] text-ink-faint">{fmtTime(timeZone, c.lastAt)}</span>}
                          {c.unread > 0 && <UnreadBadge count={c.unread} />}
                        </span>
                      </button>
                    </li>
                  ) : (
                    <li key={`group-${c.groupId}`}>
                      <button
                        type="button"
                        onClick={() => selectGroup(c)}
                        className={rowCls(selection?.kind === "group" && selection.id === c.groupId)}
                      >
                        <Avatar name={c.name} className="h-10 w-10 text-base" />
                        <span className="min-w-0 flex-1">
                          <span className="truncate text-sm font-medium text-ink">{c.name}</span>
                          <span className="block truncate text-xs text-ink-faint">
                            {c.preview
                              ? `${c.lastMine ? "我：" : c.lastSenderName ? `${c.lastSenderName}：` : ""}${c.preview}`
                              : `${c.memberCount} 人，说点什么吧`}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          {c.lastAt && <span className="text-[11px] text-ink-faint">{fmtTime(timeZone, c.lastAt)}</span>}
                          {c.unread > 0 && <UnreadBadge count={c.unread} />}
                        </span>
                      </button>
                    </li>
                  ),
                )}
              </ul>
            )}
          </div>
        </aside>

        {/* 右栏：聊天窗口（私信或群聊） */}
        <section className={`min-h-0 flex-col ${selection ? "flex" : "hidden sm:flex"}`}>
          {selection?.kind === "dm" && peer ? (
            <>
              <header className="flex items-center gap-2 border-b border-line px-4 py-3">
                <button
                  type="button"
                  onClick={closePane}
                  className="text-sm text-ink-soft hover:text-primary sm:hidden"
                  aria-label="返回消息列表"
                >
                  ←
                </button>
                <Avatar name={peer.name} url={peer.avatarUrl} className="h-8 w-8" />
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
                {msgs.map((m) => {
                  const dm = m as DmMessageView;
                  return (
                    <div key={dm.id} className={`flex ${dm.mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[75%] ${dm.mine ? "items-end" : "items-start"} flex flex-col gap-0.5`}>
                        <div
                          className={`break-words rounded-2xl px-3.5 py-2 text-sm ${
                            dm.mine
                              ? "rounded-br-sm bg-primary text-white"
                              : "rounded-bl-sm border border-line bg-sunken text-ink"
                          }`}
                        >
                          {dm.content && <p className="whitespace-pre-wrap">{dm.content}</p>}
                          {dm.attachment && <AttachmentLink att={dm.attachment} mine={dm.mine} />}
                        </div>
                        <span className="px-1 text-[11px] text-ink-faint">
                          {fmtTime(timeZone, dm.createdAt)}
                          {dm.mine && (dm.readAt ? " · 已读" : " · 未读")}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              {sendForm}
            </>
          ) : selection?.kind === "group" ? (
            <>
              <header className="flex items-center gap-2 border-b border-line px-4 py-3">
                <button
                  type="button"
                  onClick={closePane}
                  className="text-sm text-ink-soft hover:text-primary sm:hidden"
                  aria-label="返回消息列表"
                >
                  ←
                </button>
                <Avatar name={group?.name ?? "?"} className="h-8 w-8" />
                <span className="text-sm font-semibold text-ink">{group?.name ?? "…"}</span>
                {group && (
                  <>
                    <span className="text-xs text-ink-faint">{group.memberCount} 人</span>
                    {/* 群管理（邀请/踢人/退群/解散）入口：给个明确的按键，别让人靠猜「N 人」找入口 */}
                    <button
                      type="button"
                      onClick={() => setMembersOpen((v) => !v)}
                      className={`ac-btn-ghost px-2.5 py-1 text-xs ${membersOpen ? "border-primary text-primary" : ""}`}
                      title="成员与群管理"
                    >
                      群管理
                    </button>
                  </>
                )}
                <span className="ml-auto text-xs text-ink-faint">消息自动留存</span>
              </header>

              {membersOpen && group && (
                <div className="border-b border-line p-3">
                  <form onSubmit={handleInviteSubmit} className="flex gap-2">
                    <input
                      value={inviteName}
                      onChange={(e) => {
                        setInviteName(e.target.value);
                        setInviteError("");
                      }}
                      placeholder="输入用户名邀请进群"
                      className="min-w-0 flex-1 rounded-field border border-line-strong bg-surface px-3 py-1.5 text-sm outline-none focus:border-primary"
                      aria-label="邀请用户名"
                    />
                    <button
                      type="submit"
                      disabled={inviting || !inviteName.trim()}
                      className="ac-btn px-3 py-1.5 text-sm"
                    >
                      {inviting ? "…" : "邀请"}
                    </button>
                  </form>
                  {inviteError && <p className="mt-1.5 text-xs text-high">{inviteError}</p>}
                  {inviteHint && <p className="mt-1.5 text-xs text-done">{inviteHint}</p>}
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {group.members.map((m) => (
                      <li
                        key={m.userId}
                        className="flex items-center gap-1 rounded-full border border-line bg-sunken py-0.5 pl-1 pr-2"
                      >
                        <Avatar name={m.name} className="h-5 w-5 text-[10px]" />
                        <span className="text-xs text-ink">{m.name}</span>
                        {m.userId === group.ownerId ? (
                          <span className="ac-badge bg-primary-soft text-primary">群主</span>
                        ) : (
                          <IdentityBadge identity={m.identity} className="scale-90" />
                        )}
                        {group.amOwner && m.userId !== group.ownerId && (
                          <button
                            type="button"
                            disabled={groupOpBusy}
                            onClick={() => handleKick(m.userId, m.name)}
                            className="text-ink-faint hover:text-high"
                            aria-label={`移除 ${m.name}`}
                          >
                            ×
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                  {groupOpError && <p className="mt-1.5 text-xs text-high">{groupOpError}</p>}
                  <div className="mt-2 flex justify-end">
                    {group.amOwner ? (
                      <button
                        type="button"
                        disabled={groupOpBusy}
                        onClick={handleDissolve}
                        className="ac-btn-ghost px-2.5 py-1 text-xs hover:border-high hover:text-high"
                      >
                        解散群聊
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={groupOpBusy}
                        onClick={handleLeave}
                        className="ac-btn-ghost px-2.5 py-1 text-xs"
                      >
                        退群
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                {msgs.length === 0 && (
                  <p className="pt-8 text-center text-xs text-ink-faint">
                    还没有消息，发第一条吧（支持传文件，单个 ≤ 10MB）
                  </p>
                )}
                {msgs.map((m) => (
                  <GroupBubble key={m.id} m={m as GroupMessageView} tz={timeZone} />
                ))}
              </div>

              {sendForm}
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-sm text-ink-faint">
              选择左侧会话，或搜索用户名开始聊天
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
