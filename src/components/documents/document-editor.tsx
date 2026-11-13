"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { decodeTextWithFallback, extOf } from "@/lib/file-preview";
import { formatLabel, isSameEditableFormat, sheetBookTypeOf } from "@/lib/documents/format";
import { importDocxToHtml } from "@/lib/documents/docx-import.client";
import { grantEditorAction, revokeEditorAction, setCollaborationAction } from "@/app/(app)/documents/[documentId]/actions";
import { EditorSidebar } from "./editor-sidebar";
import { RichTextEditor } from "./rich-text-editor";
import { SheetEditor, type SheetEditorApi } from "./sheet-editor";
import { TextEditor } from "./text-editor";
import { useDocumentEvents } from "./use-document-events";
import type { DocumentEditorInitial, DocumentVersionDto, LockView, PresenceUser } from "./editor-types";

type StateResponse = Omit<DocumentEditorInitial, "currentUserId" | "currentUserName">;

type SaveMode = "autosave" | "manual" | "force" | "saveAs";

type Payload =
  | { kind: "text"; text: string }
  | { kind: "tiptap"; doc: unknown }
  | { kind: "sheet"; bytes: Uint8Array };

type SavePhase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "error"; message: string };

type Conflict = { currentVersion: number; latest: DocumentVersionDto | null };

type RemoteSaved = { version: number; text: string };

const HEARTBEAT_MS = 30_000;

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `s-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function decodeText(bytes: ArrayBuffer): { text: string; utf8: boolean } {
  let utf8: string | null = null;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    // GBK 或其它编码
  }
  return { text: utf8 ?? decodeTextWithFallback(bytes), utf8: utf8 !== null };
}

function defaultCopyName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}-副本`;
  return `${filename.slice(0, dot)}-副本${filename.slice(dot)}`;
}

function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

/** 包一层，避免 React Compiler 的 purity 规则把 Date.now 当成渲染期副作用 */
function nowMs(): number {
  return Date.now();
}

/** 在线文档编辑器的状态机：加载、编辑、自动保存、锁、SSE、冲突与版本。 */
export function DocumentEditor({ initial }: { initial: DocumentEditorInitial }) {
  const router = useRouter();
  const documentId = initial.document.id;
  const format = initial.document.format;
  const markdown = ["md", "markdown", "mdx"].includes(extOf(initial.document.filename));
  const bookType = sheetBookTypeOf(initial.document.filename) ?? "xlsx";

  const [sessionId] = useState(makeSessionId);
  const [docInfo, setDocInfo] = useState(initial.document);
  const [source, setSource] = useState(initial.source);
  const [canEdit, setCanEdit] = useState(initial.canEdit);
  const [canManage, setCanManage] = useState(initial.canManage);
  const [role, setRole] = useState(initial.role);
  const [lockView, setLockView] = useState<LockView | null>(initial.lock);
  const [versions, setVersions] = useState<DocumentVersionDto[]>(initial.versions);
  const [editors, setEditors] = useState(initial.editors);
  const [members, setMembers] = useState(initial.members);
  const [presence, setPresence] = useState<PresenceUser[]>([]);

  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [tiptap, setTiptap] = useState<unknown>(null);
  const [sheetBytes, setSheetBytes] = useState<ArrayBuffer | null>(null);
  const [originalUtf8, setOriginalUtf8] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [version, setVersion] = useState(initial.document.currentVersion);
  const [dirty, setDirty] = useState(false);
  const [savePhase, setSavePhase] = useState<SavePhase>({ kind: "idle" });
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [remote, setRemote] = useState<RemoteSaved | null>(null);
  const [remoteHidden, setRemoteHidden] = useState(false);
  const [lockLost, setLockLost] = useState(false);
  const [lockPending, setLockPending] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sidebar, setSidebar] = useState<null | "versions" | "permissions">(null);

  const sheetApiRef = useRef<SheetEditorApi | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const reloadingRef = useRef(false);
  const lastSaveAtRef = useRef(0);
  const lastKickRef = useRef(0);
  const dirtyRef = useRef(dirty);
  const versionRef = useRef(version);
  const conflictRef = useRef(conflict);
  const canEditRef = useRef(canEdit);
  const revokedRef = useRef(revoked);
  const collabRef = useRef(docInfo.collaborationEnabled);

  // ref 只在 effect 里同步，避免渲染期写 ref（React Compiler 规则）
  useEffect(() => {
    dirtyRef.current = dirty;
    versionRef.current = version;
    conflictRef.current = conflict;
    canEditRef.current = canEdit;
    revokedRef.current = revoked;
    collabRef.current = docInfo.collaborationEnabled;
  }, [dirty, version, conflict, canEdit, revoked, docInfo.collaborationEnabled]);

  const stateUrl = `/api/documents/${documentId}/state`;
  const contentUrl = `/api/documents/${documentId}/content`;
  const lockUrl = `/api/documents/${documentId}/lock`;
  const ownLock =
    lockView?.userId === initial.currentUserId && lockView?.sessionId === sessionId;
  const lockByOther = !!lockView && lockView.userId !== initial.currentUserId;
  const editingAllowed =
    canEdit && !revoked && phase === "ready" && (docInfo.collaborationEnabled || ownLock) && !lockLost;

  function markDirty() {
    setDirty(true);
    dirtyRef.current = true;
    setSavePhase({ kind: "idle" });
  }

  async function fetchState(): Promise<StateResponse> {
    const res = await fetch(stateUrl, { cache: "no-store" });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? "无法加载文档信息");
    }
    return (await res.json()) as StateResponse;
  }

  function applyMeta(state: StateResponse) {
    setDocInfo(state.document);
    setSource(state.source);
    setCanEdit(state.canEdit);
    setCanManage(state.canManage);
    setRole(state.role);
    setVersions(state.versions);
    setEditors(state.editors);
    setMembers(state.members);
    setLockView(state.lock);
  }

  async function fetchBytes(targetVersion?: number): Promise<ArrayBuffer> {
    const url = targetVersion ? `${contentUrl}?version=${targetVersion}` : contentUrl;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? "加载文档内容失败");
    }
    return res.arrayBuffer();
  }

  async function reload(): Promise<void> {
    if (reloadingRef.current) return;
    reloadingRef.current = true;
    setPhase("loading");
    setLoadError(null);
    try {
      const state = await fetchState();
      applyMeta(state);
      const target = state.document.currentVersion;

      if (format === "docx" && state.editorState != null) {
        setTiptap(state.editorState);
      } else if (format === "docx") {
        const bytes = await fetchBytes();
        setTiptap(await importDocxToHtml(bytes));
      } else if (format === "text") {
        const decoded = decodeText(await fetchBytes());
        setText(decoded.text);
        setOriginalUtf8(decoded.utf8);
      } else {
        setSheetBytes(await fetchBytes());
      }

      setVersion(target);
      versionRef.current = target;
      setDirty(false);
      dirtyRef.current = false;
      setConflict(null);
      conflictRef.current = null;
      setRemote(null);
      setRemoteHidden(false);
      setLockLost(false);
      setReloadToken((t) => t + 1);
      setSavePhase({ kind: "idle" });
      setPhase("ready");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载文档失败");
      setPhase("error");
    } finally {
      reloadingRef.current = false;
    }
  }

  async function refreshMeta(): Promise<void> {
    try {
      const state = await fetchState();
      applyMeta(state);
    } catch {
      // 元数据刷新失败不影响编辑；下次事件再刷
    }
  }

  const acquireLock = useCallback(async () => {
    if (!canEditRef.current || collabRef.current || revokedRef.current) return;
    setLockPending(true);
    try {
      const res = await fetch(lockUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = (await res.json().catch(() => null)) as
        | { lock?: LockView; error?: string }
        | null;
      if (res.ok && data?.lock) {
        setLockView(data.lock);
        setLockLost(false);
      } else if (res.status === 423) {
        setLockView(data?.lock ?? null);
      } else if (res.status === 403) {
        setCanEdit(false);
        setRevoked(true);
      }
    } catch {
      // 网络抖动：心跳/下一次事件会再试
    } finally {
      setLockPending(false);
    }
  }, [lockUrl, sessionId]);

  async function buildPayload(): Promise<Payload | null> {
    if (format === "text") return { kind: "text", text };
    if (format === "docx") {
      return tiptap == null ? null : { kind: "tiptap", doc: tiptap };
    }
    const bytes = sheetApiRef.current?.getBytes() ?? null;
    return bytes ? { kind: "sheet", bytes } : null;
  }

  async function performSave(opts: {
    mode: SaveMode;
    saveAsName?: string;
    payload?: Payload;
  }): Promise<boolean> {
    if (revokedRef.current || !canEditRef.current) return false;
    if (conflictRef.current && opts.mode !== "force" && opts.mode !== "saveAs") {
      setSidebar(null);
      return false;
    }
    if (savingRef.current) {
      pendingRef.current = true;
      return false;
    }

    const payload = opts.payload ?? (await buildPayload());
    if (!payload) return false;

    savingRef.current = true;
    setSavePhase({ kind: "saving" });

    try {
      let res: Response;
      if (payload.kind === "sheet") {
        const query = new URLSearchParams({
          baseVersion: String(versionRef.current),
          sessionId,
          note: opts.mode === "autosave" ? "autosave" : "manual",
        });
        if (opts.mode === "force") query.set("force", "1");
        if (opts.mode === "saveAs" && opts.saveAsName) query.set("asName", opts.saveAsName);
        res = await fetch(`/api/documents/${documentId}/save-sheet?${query.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: payload.bytes as unknown as BodyInit,
        });
      } else {
        const content =
          payload.kind === "text"
            ? { kind: "text" as const, text: payload.text }
            : { kind: "tiptap" as const, doc: payload.doc };
        res = await fetch(`/api/documents/${documentId}/save`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseVersion: versionRef.current,
            sessionId,
            force: opts.mode === "force" || undefined,
            saveAsName: opts.mode === "saveAs" ? opts.saveAsName : undefined,
            note: opts.mode === "autosave" ? "autosave" : "manual",
            content,
          }),
        });
      }

      const data = (await res.json().catch(() => null)) as
        | {
            version?: number;
            savedAs?: boolean;
            documentId?: string;
            error?: string;
            code?: string;
            currentVersion?: number;
            lock?: LockView | null;
          }
        | null;

      if (res.ok) {
        const now = nowMs();
        lastSaveAtRef.current = now;
        setDirty(false);
        dirtyRef.current = false;
        setSavePhase({ kind: "saved", at: now });
        setConflict(null);
        conflictRef.current = null;
        setRemote(null);
        setRemoteHidden(false);
        if (format === "text") setOriginalUtf8(true);

        if (data?.savedAs && data.documentId) {
          router.push(`/documents/${data.documentId}`);
          return true;
        }

        const next = data?.version ?? versionRef.current + 1;
        setVersion(next);
        versionRef.current = next;
        void refreshMeta();
        return true;
      }

      if (res.status === 409 && data?.code === "VERSION_CONFLICT") {
        const currentVersion = data.currentVersion ?? versionRef.current + 1;
        setConflict({ currentVersion, latest: null });
        conflictRef.current = { currentVersion, latest: null };
        setSavePhase({ kind: "error", message: "文档已被其他人保存" });
        void (async () => {
          const state = await fetchState().catch(() => null);
          if (!state) return;
          applyMeta(state);
          const latest = state.versions.find((v) => v.version === currentVersion) ?? null;
          setConflict((c) => (c ? { ...c, latest } : c));
          conflictRef.current = { currentVersion, latest };
        })();
        return false;
      }

      if (res.status === 409 && data?.code === "LOCK_LOST") {
        setLockLost(true);
        setSavePhase({ kind: "error", message: "编辑锁已失效，请重新获取编辑权" });
        return false;
      }

      if (res.status === 423) {
        if (data?.lock) setLockView(data.lock);
        setSavePhase({ kind: "error", message: data?.error ?? "其他成员正在编辑该文档" });
        return false;
      }

      if (res.status === 403) {
        setCanEdit(false);
        setSavePhase({ kind: "error", message: data?.error ?? "没有编辑权限" });
        return false;
      }

      setSavePhase({ kind: "error", message: data?.error ?? "保存失败" });
      return false;
    } catch {
      setSavePhase({ kind: "error", message: "网络异常，稍后会重试" });
      return false;
    } finally {
      savingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        if (
          dirtyRef.current &&
          canEditRef.current &&
          !conflictRef.current &&
          !revokedRef.current
        ) {
          window.setTimeout(() => {
            void saveRef.current({ mode: "autosave" });
          }, 800);
        }
      }
    }
  }

  const saveRef = useRef(performSave);
  useEffect(() => {
    saveRef.current = performSave;
  });

  const kickManualSave = useCallback(() => {
    const now = Date.now();
    if (now - lastKickRef.current < 250) return;
    lastKickRef.current = now;
    void saveRef.current({ mode: "manual" });
  }, []);

  // ---------------------------------------------------------------- 生命周期

  useEffect(() => {
    // 延迟一拍，避免在 effect 内同步 setState（React Compiler 规则）
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 单人模式：没有自己的锁就尝试获取；被他人持有时只读
  useEffect(() => {
    if (!canEdit || revoked || docInfo.collaborationEnabled) return;
    if (lockView && lockView.userId !== initial.currentUserId) return;
    if (ownLock) return;
    const timer = window.setTimeout(() => void acquireLock(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, revoked, docInfo.collaborationEnabled, lockView, ownLock]);

  // 心跳续约
  useEffect(() => {
    if (!ownLock || docInfo.collaborationEnabled) return;
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(lockUrl, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
        if (res.status === 409) {
          setLockLost(true);
          setLockView(null);
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as { lock?: LockView };
          if (data.lock) setLockView(data.lock);
        }
      } catch {
        // 网络异常留到下一轮
      }
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [ownLock, docInfo.collaborationEnabled, lockUrl, sessionId]);

  // 离开页面释放锁
  useEffect(() => {
    const release = () => {
      void fetch(`${lockUrl}?sessionId=${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        keepalive: true,
      }).catch(() => {});
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [lockUrl, sessionId]);

  // 自动保存：按格式防抖 + 最小间隔；有冲突/远程新版本时暂停
  useEffect(() => {
    if (!dirty || !editingAllowed || conflict || remote) return;
    const debounce = format === "text" ? 1500 : format === "docx" ? 3000 : 2000;
    const minGap = format === "text" ? 8000 : format === "docx" ? 20000 : 15000;
    const wait = Math.max(debounce, minGap - (Date.now() - lastSaveAtRef.current));
    const timer = window.setTimeout(() => {
      void saveRef.current({ mode: "autosave" });
    }, wait);
    return () => window.clearTimeout(timer);
  }, [dirty, editingAllowed, conflict, remote, format, text, tiptap]);

  // 切走标签页时尽量落一次盘
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      if (!dirtyRef.current || !canEditRef.current || conflictRef.current || revokedRef.current)
        return;
      void saveRef.current({ mode: "autosave" });
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // 未保存离开提示
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // 全局 Ctrl/Cmd+S（各编辑器内部的快捷键靠 kick 去重）
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        kickManualSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kickManualSave]);

  // ---------------------------------------------------------------- SSE

  useDocumentEvents(documentId, {
    hello: (event) => {
      setPresence(event.users);
      setLockView(event.lock);
      setDocInfo((d) =>
        d.collaborationEnabled === event.collaborationEnabled
          ? d
          : { ...d, collaborationEnabled: event.collaborationEnabled },
      );
      if (event.version > versionRef.current && !dirtyRef.current) void reload();
      else if (event.version > versionRef.current && dirtyRef.current) {
        setRemote({ version: event.version, text: "文档已有新版本，自动保存已暂停" });
        setRemoteHidden(false);
      }
    },
    presence: (event) => setPresence(event.users),
    saved: (event) => {
      if (event.version <= versionRef.current) return;
      if (event.actorId === initial.currentUserId) {
        // 自己在另一个标签页保存的：本地干净就同步，脏则等本次保存返回
        if (!dirtyRef.current) void reload();
        return;
      }
      if (dirtyRef.current) {
        setRemote({
          version: event.version,
          text: `${event.actorName} 已保存 v${event.version}，你的未保存修改需要手动处理`,
        });
        setRemoteHidden(false);
      } else {
        void reload();
      }
    },
    settings: (event) => {
      setDocInfo((d) => ({ ...d, collaborationEnabled: event.collaborationEnabled }));
      setLockLost(false);
      if (event.collaborationEnabled) setLockView(null);
    },
    permission: (event) => {
      if (event.userId === initial.currentUserId) {
        setCanEdit(event.canEdit);
        if (!event.canEdit) {
          setLockView(null);
          setLockLost(false);
        }
      }
      void refreshMeta();
    },
    lock: (event) => {
      if (event.lock) {
        setLockView(event.lock);
        if (
          event.lock.userId === initial.currentUserId &&
          event.lock.sessionId !== sessionId
        ) {
          setLockLost(true);
        }
      } else {
        setLockView(null);
      }
    },
    revoked: (event) => {
      setRevoked(true);
      setCanEdit(false);
      setLockView(null);
      setSavePhase({ kind: "error", message: event.reason || "访问权限已被收回" });
    },
  });

  // ---------------------------------------------------------------- 权限动作

  async function toggleCollaboration(enabled: boolean) {
    setBusy(true);
    try {
      const result = await setCollaborationAction(documentId, enabled);
      if ("error" in result) {
        window.alert(result.error);
        return;
      }
      setDocInfo((d) => ({ ...d, collaborationEnabled: enabled }));
      setLockLost(false);
      if (!enabled) setLockView(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleGrant(userId: string) {
    setBusy(true);
    try {
      const result = await grantEditorAction(documentId, userId);
      if ("error" in result) window.alert(result.error);
      else await refreshMeta();
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(userId: string) {
    setBusy(true);
    try {
      const result = await revokeEditorAction(documentId, userId);
      if ("error" in result) window.alert(result.error);
      else await refreshMeta();
    } finally {
      setBusy(false);
    }
  }

  async function restoreVersion(targetVersion: number) {
    setBusy(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: targetVersion, sessionId }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        window.alert(data?.error ?? "恢复版本失败");
        return;
      }
      setSidebar(null);
      await reload();
    } catch {
      window.alert("恢复版本失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function saveAs() {
    if (!canEdit || readOnly) return;
    const suggested = defaultCopyName(docInfo.filename);
    const name = window.prompt("另存为新文件名（保持相同扩展名）", suggested)?.trim();
    if (!name) return;
    if (!isSameEditableFormat(docInfo.filename, name, format)) {
      window.alert("另存为只能使用与原文件相同的格式/扩展名");
      return;
    }
    void saveRef.current({ mode: "saveAs", saveAsName: name });
  }

  // ---------------------------------------------------------------- 渲染

  const readOnlyReason =
    revoked
      ? "你的访问权限已被收回，当前内容只读"
      : !canEdit
        ? role === "teacher"
          ? "教师默认可查看；如需编辑，请上传者或团队管理员在「权限」中授权"
          : "你没有该文档的编辑权限"
        : lockLost
          ? "编辑锁已失效（可能已在另一个标签页继续编辑）"
          : lockByOther
            ? `${lockView?.userName ?? "其他成员"}正在编辑该文档，你当前为只读`
            : !docInfo.collaborationEnabled && !ownLock
              ? lockPending
                ? "正在获取编辑锁…"
                : "等待编辑锁…"
              : null;
  const readOnly = readOnlyReason !== null;

  const saveStatusText =
    savePhase.kind === "saving"
      ? "保存中…"
      : savePhase.kind === "error"
        ? savePhase.message
        : dirty
          ? "有未保存的修改"
          : savePhase.kind === "saved"
            ? `已保存 · ${timeLabel(savePhase.at)}`
            : `v${version}`;

  const backHref =
    source.projectId && source.taskId
      ? `/projects/${source.projectId}/tasks/${source.taskId}`
      : null;

  const conflictCopy = conflict
    ? defaultCopyName(docInfo.filename)
    : "";

  return (
    <div className="-mx-4 -my-4 flex h-[calc(100dvh-3rem)] flex-col overflow-hidden border-line bg-surface sm:-mx-6 sm:-my-6 sm:h-[calc(100dvh-4rem)] sm:border">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        {backHref ? (
          <a href={backHref} className="ac-btn-ghost px-2 py-1 text-xs">
            ← 返回
          </a>
        ) : (
          <button type="button" className="ac-btn-ghost px-2 py-1 text-xs" onClick={() => router.back()}>
            ← 返回
          </button>
        )}
        <span className="ac-badge">{formatLabel(format)}</span>
        <span className="min-w-0 max-w-[40vw] truncate text-sm font-medium text-ink" title={docInfo.filename}>
          {docInfo.filename}
        </span>
        {readOnly && <span className="ac-badge text-ink-faint">只读</span>}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {presence.length > 0 && (
            <div className="flex items-center -space-x-1.5" aria-label="在线成员">
              {presence.slice(0, 5).map((u) => (
                <span
                  key={u.userId}
                  title={u.name}
                  className="grid h-6 w-6 place-items-center rounded-full border border-line bg-primary text-[10px] font-semibold text-white"
                >
                  {u.name.charAt(0) || "?"}
                </span>
              ))}
              {presence.length > 5 && (
                <span className="pl-2 text-[11px] text-ink-faint">+{presence.length - 5}</span>
              )}
            </div>
          )}

          <span
            className={`text-[11px] ${
              savePhase.kind === "error" ? "text-danger" : "text-ink-faint"
            }`}
            title={savePhase.kind === "error" ? savePhase.message : undefined}
          >
            {saveStatusText}
          </span>

          <button
            type="button"
            className="ac-btn px-2.5 py-1 text-xs"
            disabled={!canEdit || readOnly || !dirty || savePhase.kind === "saving"}
            onClick={kickManualSave}
          >
            {savePhase.kind === "saving" ? "保存中" : "保存"}
          </button>
          <button
            type="button"
            className="ac-btn-ghost px-2 py-1 text-xs"
            disabled={!canEdit || readOnly}
            onClick={saveAs}
          >
            另存为
          </button>
          <button
            type="button"
            className="ac-btn-ghost px-2 py-1 text-xs"
            onClick={() => setSidebar(sidebar === "versions" ? null : "versions")}
          >
            历史版本
          </button>
          {canManage && (
            <button
              type="button"
              className="ac-btn-ghost px-2 py-1 text-xs"
              onClick={() => setSidebar(sidebar === "permissions" ? null : "permissions")}
            >
              权限
            </button>
          )}
          <a href={contentUrl} className="ac-btn-ghost px-2 py-1 text-xs" download>
            下载
          </a>
        </div>
      </header>

      {readOnlyReason && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-soft">
          <span>{readOnlyReason}</span>
          {lockLost && canEdit && !docInfo.collaborationEnabled && (
            <button
              type="button"
              className="ac-btn-ghost px-2 py-0.5 text-[11px]"
              onClick={() => {
                setLockLost(false);
                void acquireLock();
              }}
            >
              重新获取编辑权
            </button>
          )}
        </div>
      )}

      {remote && !remoteHidden && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-amber-50 px-3 py-1.5 text-xs text-ink-soft">
          <span>{remote.text}</span>
          <button
            type="button"
            className="ac-btn-ghost px-2 py-0.5 text-[11px]"
            onClick={() => void reload()}
          >
            加载最新（丢弃我的修改）
          </button>
          <button
            type="button"
            className="ac-btn-ghost px-2 py-0.5 text-[11px]"
            onClick={() => setRemoteHidden(true)}
          >
            继续编辑
          </button>
        </div>
      )}

      {format === "text" && !originalUtf8 && phase === "ready" && (
        <div className="border-b border-line bg-surface-2 px-3 py-1.5 text-xs text-ink-faint">
          原文件不是 UTF-8 编码，保存后将统一转为 UTF-8（换行也会规范化）。
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {phase === "loading" ? (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
              正在加载文档…
            </div>
          ) : phase === "error" ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-danger">{loadError}</p>
              <div className="flex gap-2">
                <button type="button" className="ac-btn px-3 py-1.5 text-xs" onClick={() => void reload()}>
                  重试
                </button>
                {backHref && (
                  <a href={backHref} className="ac-btn-ghost px-3 py-1.5 text-xs">
                    返回任务
                  </a>
                )}
              </div>
            </div>
          ) : format === "text" ? (
            <TextEditor
              value={text}
              onChange={(value) => {
                setText(value);
                markDirty();
              }}
              readOnly={readOnly}
              markdown={markdown}
              onSave={kickManualSave}
            />
          ) : format === "docx" ? (
            <RichTextEditor
              content={tiptap}
              reloadToken={reloadToken}
              readOnly={readOnly}
              onChange={(doc) => {
                setTiptap(doc);
                markDirty();
              }}
              onSave={kickManualSave}
            />
          ) : (
            <SheetEditor
              bytes={sheetBytes}
              bookType={bookType}
              reloadToken={reloadToken}
              readOnly={readOnly}
              apiRef={sheetApiRef}
              onDirty={markDirty}
              onSave={kickManualSave}
            />
          )}
        </div>

        {sidebar && (
          <EditorSidebar
            key={sidebar}
            initialTab={sidebar}
            canEdit={canEdit}
            canManage={canManage}
            ownerUserId={source.ownerUserId}
            collaborationEnabled={docInfo.collaborationEnabled}
            versions={versions}
            editors={editors}
            members={members}
            currentUserId={initial.currentUserId}
            busy={busy}
            onToggleCollaboration={(enabled) => void toggleCollaboration(enabled)}
            onGrant={(userId) => void handleGrant(userId)}
            onRevoke={(userId) => void handleRevoke(userId)}
            onRestoreVersion={(v) => void restoreVersion(v)}
            onClose={() => setSidebar(null)}
          />
        )}
      </div>

      {conflict && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="保存冲突"
        >
          <div className="w-full max-w-md space-y-3 rounded-lg border border-line bg-surface p-5 shadow-xl">
            <h2 className="font-display text-lg font-semibold text-ink">文档已被其他人保存</h2>
            <p className="text-sm text-ink-soft">
              你在 v{version} 的基础上编辑，最新版本是 v{conflict.currentVersion}
              {conflict.latest
                ? `（${conflict.latest.creatorName ?? "成员"}，${new Date(
                    conflict.latest.createdAt,
                  ).toLocaleString("zh-CN")}）`
                : ""}
              。请选择处理方式：
            </p>
            <div className="space-y-2">
              <button
                type="button"
                className="ac-btn w-full px-3 py-2 text-sm"
                onClick={() => {
                  setConflict(null);
                  conflictRef.current = null;
                  void reload();
                }}
              >
                加载最新版本（丢弃我的未保存修改）
              </button>
              <button
                type="button"
                className="ac-btn-ghost w-full px-3 py-2 text-sm"
                onClick={() => {
                  setConflict(null);
                  conflictRef.current = null;
                  void saveRef.current({ mode: "force" });
                }}
              >
                用我的版本覆盖最新
              </button>
              <button
                type="button"
                className="ac-btn-ghost w-full px-3 py-2 text-sm"
                onClick={() => {
                  const name = window.prompt("另存为副本的文件名", conflictCopy)?.trim();
                  if (!name) return;
                  if (!isSameEditableFormat(docInfo.filename, name, format)) {
                    window.alert("另存为只能使用与原文件相同的格式/扩展名");
                    return;
                  }
                  setConflict(null);
                  conflictRef.current = null;
                  void saveRef.current({ mode: "saveAs", saveAsName: name });
                }}
              >
                另存为副本
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-xs text-ink-faint hover:text-ink"
                onClick={() => {
                  setConflict(null);
                  conflictRef.current = null;
                  setRemote({
                    version: conflict.currentVersion,
                    text: "存在新版本，自动保存已暂停，手动保存时会再次提示冲突",
                  });
                  setRemoteHidden(false);
                }}
              >
                取消，稍后处理
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
