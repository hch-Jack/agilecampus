"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
// 局域网 http://<IP> 属于非安全上下文：先补齐 SuperDoc/BetterOffice 需要的 crypto API
import "@/lib/insecure-crypto-polyfill";
import { decodeTextWithFallback, extOf } from "@/lib/file-preview";
import { formatLabel, isSameEditableFormat, sheetBookTypeOf } from "@/lib/documents/format";
import { grantEditorAction, revokeEditorAction, setCollaborationAction } from "@/app/(app)/documents/[documentId]/actions";
import {
  LibrarySaveAsDialog,
  type LibrarySaveInput,
} from "@/components/library/library-save-as-dialog";
import { FileTypeIcon } from "@/components/file-type-icon";
import { EditorSidebar } from "./editor-sidebar";
import { PptxEditorHost, type PptxEditorApi } from "./pptx-editor";
import { SheetEditor, type SheetEditorApi } from "./sheet-editor";
import { SuperDocEditor, type SuperDocEditorApi } from "./superdoc-editor";
import { TextEditor, type TextEditorApi } from "./text-editor";
import { XlsxEditorHost, type XlsxEditorApi } from "./xlsx-editor";
import type { AiEditResponse, AiReplacement } from "@/lib/documents/ai-edits";
import { useDocumentEvents } from "./use-document-events";
import type { DocumentEditorInitial, DocumentVersionDto, LockView, PresenceUser } from "./editor-types";

type StateResponse = Omit<DocumentEditorInitial, "currentUserId" | "currentUserName">;

type SaveMode = "autosave" | "manual" | "force" | "saveAs";

type Payload =
  | { kind: "text"; text: string }
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "sheet"; bytes: Uint8Array }
  | { kind: "pptx"; bytes: Uint8Array };

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

function downloadBlobBytes(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  const grantsEnabled = initial.grantsEnabled !== false;
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
  const [docxBytes, setDocxBytes] = useState<ArrayBuffer | null>(null);
  const [sheetBytes, setSheetBytes] = useState<ArrayBuffer | null>(null);
  const [pptxBytes, setPptxBytes] = useState<ArrayBuffer | null>(null);
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
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [savedHint, setSavedHint] = useState("");
  const [exitTarget, setExitTarget] = useState<{ href: string | null } | null>(null);
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [aiHint, setAiHint] = useState("");
  const [aiPreview, setAiPreview] = useState<{
    summary: string;
    edits: AiReplacement[];
  } | null>(null);
  const textApiRef = useRef<TextEditorApi | null>(null);

  const sheetApiRef = useRef<SheetEditorApi | null>(null);
  const xlsxApiRef = useRef<XlsxEditorApi | null>(null);
  const docxApiRef = useRef<SuperDocEditorApi | null>(null);
  const pptxApiRef = useRef<PptxEditorApi | null>(null);
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const reloadingRef = useRef(false);
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

      if (format === "docx") {
        // SuperDoc 直接在 DOCX 字节上编辑；旧版 Tiptap editorState 不再使用
        setDocxBytes(await fetchBytes());
      } else if (format === "pptx") {
        setPptxBytes(await fetchBytes());
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
      const bytes = await docxApiRef.current?.getBytes();
      return bytes ? { kind: "docx", bytes } : null;
    }
    if (format === "pptx") {
      const bytes = await pptxApiRef.current?.getBytes();
      return bytes ? { kind: "pptx", bytes } : null;
    }
    const bytes =
      (bookType === "xlsx"
        ? await xlsxApiRef.current?.getBytes()
        : await sheetApiRef.current?.getBytes()) ?? null;
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
      if (payload.kind !== "text") {
        const query = new URLSearchParams({
          baseVersion: String(versionRef.current),
          sessionId,
          note: opts.mode === "autosave" ? "autosave" : "manual",
        });
        if (opts.mode === "force") query.set("force", "1");
        if (opts.mode === "saveAs" && opts.saveAsName) query.set("asName", opts.saveAsName);
        const endpoint =
          payload.kind === "sheet"
            ? "save-sheet"
            : payload.kind === "docx"
              ? "save-docx"
              : "save-pptx";
        res = await fetch(`/api/documents/${documentId}/${endpoint}?${query.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: payload.bytes as unknown as BodyInit,
        });
      } else {
        res = await fetch(`/api/documents/${documentId}/save`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            baseVersion: versionRef.current,
            sessionId,
            force: opts.mode === "force" || undefined,
            saveAsName: opts.mode === "saveAs" ? opts.saveAsName : undefined,
            note: opts.mode === "autosave" ? "autosave" : "manual",
            content: { kind: "text" as const, text: payload.text },
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

  // 不做自动保存：未保存的修改只在用户点「保存」或退出确认时落库，
  // 避免每次自动保存都生成一个新版本。离开页面前仍由浏览器兜底提示。

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

  // 应用内导航（顶栏、面包屑等）在未保存时先拦下来询问
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      // 编辑器内容里的链接（文档内跳转/外链）不拦
      if (anchor.closest("[data-doc-editor]")) return;
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      event.preventDefault();
      event.stopPropagation();
      setExitTarget({ href });
    };
    window.addEventListener("click", onClick, true);
    return () => window.removeEventListener("click", onClick, true);
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
    setSaveAsOpen(true);
  }

  // ---------------------------------------------------------------- AI 编辑

  const aiSupported =
    format === "text" ||
    format === "docx" ||
    format === "pptx" ||
    (format === "sheet" && bookType === "xlsx");

  async function readAiContent(): Promise<{ content: string; selection?: string }> {
    if (format === "text") {
      return {
        content: text,
        selection: textApiRef.current?.getSelection() || undefined,
      };
    }
    if (format === "docx") {
      return { content: (await docxApiRef.current?.getText()) ?? "" };
    }
    if (format === "pptx") {
      return { content: (await pptxApiRef.current?.getMarkdown()) ?? "" };
    }
    if (format === "sheet" && bookType === "xlsx") {
      return { content: (await xlsxApiRef.current?.getMarkdown()) ?? "" };
    }
    return { content: "" };
  }

  function openAiDialog() {
    if (!aiSupported) return;
    setAiInstruction("");
    setAiError("");
    setAiPreview(null);
    setAiOpen(true);
  }

  async function runAiEdits() {
    const instruction = aiInstruction.trim();
    if (!instruction || aiBusy) return;
    setAiBusy(true);
    setAiError("");
    setAiPreview(null);
    try {
      const { content: raw, selection } = await readAiContent();
      if (!raw.trim()) {
        setAiError("当前文档内容为空，无法生成修改建议");
        return;
      }
      const content =
        raw.length > 110_000 ? `${raw.slice(0, 110_000)}\n…（内容过长，已截断）` : raw;
      const res = await fetch(`/api/documents/${documentId}/ai-edits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction, content, selection }),
      });
      const data = (await res.json().catch(() => null)) as
        | (AiEditResponse & { error?: string })
        | { error?: string }
        | null;
      if (!res.ok || !data || "error" in data) {
        setAiError((data as { error?: string } | null)?.error ?? "AI 生成失败，请稍后重试");
        return;
      }
      if (!("kind" in data)) {
        setAiError("AI 返回格式不正确，请重试");
        return;
      }
      const result = data as AiEditResponse;
      if (result.kind === "cells") {
        if (format !== "sheet" || bookType !== "xlsx" || !xlsxApiRef.current) {
          setAiError("当前格式不支持单元格修改");
          return;
        }
        if (result.edits.length === 0) {
          setAiError(result.summary || "AI 没有给出可应用的修改");
          return;
        }
        const stagedResult = await xlsxApiRef.current.stageAiEdits({
          summary: result.summary,
          cells: result.edits,
        });
        setAiOpen(false);
        setAiHint(
          `已生成 ${stagedResult.staged} 处待确认修改${stagedResult.failed.length ? `（${stagedResult.failed.length} 处未找到目标）` : ""}，请在表格的提案审阅区确认。`,
        );
        return;
      }

      if (result.edits.length === 0) {
        setAiError(result.summary || "AI 没有给出可应用的修改");
        return;
      }
      if (format === "text") {
        setAiPreview({ summary: result.summary, edits: result.edits });
        return;
      }
      if (format === "docx") {
        if (!docxApiRef.current) {
          setAiError("Word 编辑器尚未就绪");
          return;
        }
        const applied = await docxApiRef.current.applyAiEdits(result.edits);
        setAiOpen(false);
        setAiHint(
          `已生成 ${applied.applied} 处修订${applied.failed.length ? `（${applied.failed.length} 处未匹配到原文）` : ""}，请在工具条接受/拒绝修订。`,
        );
        return;
      }
      if (format === "pptx") {
        if (!pptxApiRef.current) {
          setAiError("演示文稿编辑器尚未就绪");
          return;
        }
        const stagedResult = await pptxApiRef.current.stageAiEdits({
          summary: result.summary,
          edits: result.edits,
        });
        setAiOpen(false);
        setAiHint(
          `已生成 ${stagedResult.staged} 处待确认修改${stagedResult.failed.length ? `（${stagedResult.failed.length} 处未匹配到原文）` : ""}，请在演示文稿的提案审阅区确认。`,
        );
        return;
      }
      setAiError("当前格式暂不支持 AI 编辑");
    } catch (e) {
      setAiError(e instanceof Error ? e.message : "AI 生成失败，请稍后重试");
    } finally {
      setAiBusy(false);
    }
  }

  function applyTextAiEdits() {
    if (!aiPreview) return;
    let next = text;
    let applied = 0;
    const failed: string[] = [];
    for (const edit of aiPreview.edits) {
      const at = next.indexOf(edit.find);
      if (at < 0) {
        failed.push(edit.find);
        continue;
      }
      next = `${next.slice(0, at)}${edit.replace}${next.slice(at + edit.find.length)}`;
      applied += 1;
    }
    if (applied > 0) {
      setText(next);
      markDirty();
      setAiHint(
        `已应用 ${applied} 处修改${failed.length ? `（${failed.length} 处未匹配到原文）` : ""}，记得保存。`,
      );
    } else {
      setAiError("所有修改都未能在原文中匹配，请调整指令或手动编辑");
      return;
    }
    setAiOpen(false);
    setAiPreview(null);
  }

  /** 返回/离开页面：有未保存修改时先让用户选保存还是放弃 */
  function requestExit(href: string | null) {
    if (!dirtyRef.current || !editingAllowed) {
      if (href) router.push(href);
      else router.back();
      return;
    }
    setExitTarget({ href });
  }

  function applyExit(target: { href: string | null }) {
    setExitTarget(null);
    if (target.href) router.push(target.href);
    else router.back();
  }

  async function saveAndExit() {
    const target = exitTarget;
    if (!target) return;
    const ok = await saveRef.current({ mode: "manual" });
    if (!ok) return; // 保存失败/冲突：留在页面处理
    applyExit(target);
  }

  function discardAndExit() {
    const target = exitTarget;
    if (!target) return;
    setDirty(false);
    dirtyRef.current = false;
    applyExit(target);
  }

  async function saveToLibrary(input: LibrarySaveInput): Promise<{
    ok: boolean;
    error?: string;
  }> {
    const payload = await buildPayload();
    if (!payload) return { ok: false, error: "当前内容尚未准备好，请稍后再试" };
    try {
      let res: Response;
      if (payload.kind !== "text") {
        const query = new URLSearchParams({
          filename: input.filename,
          scope: input.scope,
        });
        if (input.teamId) query.set("teamId", input.teamId);
        if (input.folderId === null) query.set("folderId", "root");
        else if (input.folderId) query.set("folderId", input.folderId);
        const endpoint =
          payload.kind === "sheet"
            ? "save-as-library-sheet"
            : payload.kind === "docx"
              ? "save-as-library-docx"
              : "save-as-library-pptx";
        res = await fetch(`/api/documents/${documentId}/${endpoint}?${query.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: payload.bytes as unknown as BodyInit,
        });
      } else {
        res = await fetch(`/api/documents/${documentId}/save-as-library`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            filename: input.filename,
            scope: input.scope,
            teamId: input.teamId,
            folderId: input.folderId === null ? "root" : input.folderId,
            content: { kind: "text" as const, text: payload.text },
          }),
        });
      }
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      return res.ok ? { ok: true } : { ok: false, error: data?.error ?? "保存失败" };
    } catch {
      return { ok: false, error: "网络异常，请稍后重试" };
    }
  }

  async function exportCopy(filename: string): Promise<boolean> {
    const payload = await buildPayload();
    if (!payload) return false;
    try {
      let res: Response;
      if (payload.kind !== "text") {
        const query = new URLSearchParams({ filename });
        const endpoint =
          payload.kind === "sheet"
            ? "export-sheet"
            : payload.kind === "docx"
              ? "export-docx"
              : "export-pptx";
        res = await fetch(`/api/documents/${documentId}/${endpoint}?${query.toString()}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: payload.bytes as unknown as BodyInit,
        });
      } else {
        res = await fetch(`/api/documents/${documentId}/export`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ filename, content: { kind: "text", text: payload.text } }),
        });
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        window.alert(data?.error ?? "导出失败");
        return false;
      }
      downloadBlobBytes(await res.blob(), filename);
      return true;
    } catch {
      window.alert("导出失败，请稍后重试");
      return false;
    }
  }

  async function saveAsAttachment(filename: string): Promise<boolean> {
    if (!canEdit || readOnly) return false;
    return saveRef.current({ mode: "saveAs", saveAsName: filename });
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
    <div
      data-doc-editor-root
      className="-mx-4 -my-4 flex h-[calc(100dvh-3rem)] w-full flex-col overflow-hidden border-line bg-surface sm:-mx-6 sm:-my-6 sm:h-[calc(100dvh-4rem)] sm:border"
    >
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        {backHref ? (
          <a
            href={backHref}
            className="ac-btn-ghost px-2 py-1 text-xs"
            onClick={(e) => {
              if (!dirtyRef.current) return;
              e.preventDefault();
              requestExit(backHref);
            }}
          >
            ← 返回
          </a>
        ) : (
          <button
            type="button"
            className="ac-btn-ghost px-2 py-1 text-xs"
            onClick={() => requestExit(null)}
          >
            ← 返回
          </button>
        )}
        <span className="ac-badge">{formatLabel(format)}</span>
        <FileTypeIcon filename={docInfo.filename} className="h-4 w-4 shrink-0" />
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
            disabled={!canEdit || readOnly || !aiSupported}
            onClick={openAiDialog}
            title={
              aiSupported
                ? "让 AI 助手为当前文档生成待确认修改"
                : "AI 编辑暂支持文本、.docx、.xlsx、.pptx"
            }
          >
            ✨ AI 编辑
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

      {savedHint && (
        <div className="border-b border-line bg-surface-2 px-3 py-1 text-xs text-done">
          {savedHint}
        </div>
      )}

      {aiHint && (
        <div className="flex items-center gap-2 border-b border-line bg-primary-soft px-3 py-1.5 text-xs text-primary">
          <span className="min-w-0 flex-1">{aiHint}</span>
          <button
            type="button"
            className="text-ink-faint hover:text-ink"
            onClick={() => setAiHint("")}
          >
            ×
          </button>
        </div>
      )}

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

      <div className="flex min-h-0 flex-1" data-doc-editor>
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
              apiRef={textApiRef}
            />
          ) : format === "docx" ? (
            <SuperDocEditor
              bytes={docxBytes}
              readOnly={readOnly}
              filename={docInfo.filename}
              userName={initial.currentUserName}
              apiRef={docxApiRef}
              onDirty={markDirty}
              onSave={kickManualSave}
            />
          ) : format === "pptx" ? (
            <PptxEditorHost
              bytes={pptxBytes}
              reloadToken={reloadToken}
              readOnly={readOnly}
              filename={docInfo.filename}
              apiRef={pptxApiRef}
              onDirty={markDirty}
              onSave={kickManualSave}
            />
          ) : bookType === "xlsx" ? (
            <XlsxEditorHost
              bytes={sheetBytes}
              reloadToken={reloadToken}
              readOnly={readOnly}
              filename={docInfo.filename}
              apiRef={xlsxApiRef}
              onDirty={markDirty}
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
            grantsEnabled={grantsEnabled}
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

      {aiOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="AI 编辑"
        >
          <div className="w-full max-w-lg space-y-3 rounded-lg border border-line bg-surface p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-ink">✨ AI 编辑</h2>
              <button
                type="button"
                className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-sunken hover:text-ink"
                aria-label="关闭"
                onClick={() => !aiBusy && setAiOpen(false)}
              >
                ×
              </button>
            </div>

            {aiPreview ? (
              <>
                <p className="text-sm text-ink-soft">{aiPreview.summary}</p>
                <ul className="max-h-64 space-y-2 overflow-y-auto rounded-field border border-line p-2 text-xs">
                  {aiPreview.edits.map((edit, i) => (
                    <li key={`${i}-${edit.find}`} className="space-y-0.5">
                      <p className="whitespace-pre-wrap text-high line-through">{edit.find}</p>
                      <p className="whitespace-pre-wrap text-done">{edit.replace}</p>
                      {edit.note && <p className="text-ink-faint">{edit.note}</p>}
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="ac-btn-ghost px-3 py-1.5 text-xs"
                    onClick={() => {
                      setAiOpen(false);
                      setAiPreview(null);
                    }}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="ac-btn px-3 py-1.5 text-xs"
                    onClick={applyTextAiEdits}
                  >
                    应用修改
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs text-ink-faint">
                  {format === "text"
                    ? "如已选中文本，AI 会优先针对选中片段；否则针对整份文件。"
                    : format === "sheet"
                      ? "AI 会以单元格写入的形式给出修改，应用后会进入待审阅提案。"
                      : "AI 会以修订/提案的形式给出修改，应用后需要你确认接受。"}
                </p>
                <textarea
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  rows={4}
                  autoFocus
                  placeholder="例如：把标题改得更正式；检查错别字；把第 3 行数据改成……"
                  className="ac-field w-full text-sm"
                />
                {aiError && <p className="text-xs text-high">{aiError}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    className="ac-btn-ghost px-3 py-1.5 text-xs"
                    disabled={aiBusy}
                    onClick={() => setAiOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="ac-btn px-3 py-1.5 text-xs"
                    disabled={aiBusy || !aiInstruction.trim()}
                    onClick={() => void runAiEdits()}
                  >
                    {aiBusy ? "生成中…" : "生成修改建议"}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {exitTarget && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="未保存的修改"
        >
          <div className="w-full max-w-sm space-y-3 rounded-lg border border-line bg-surface p-5 shadow-xl">
            <h2 className="font-display text-lg font-semibold text-ink">有未保存的修改</h2>
            <p className="text-sm text-ink-soft">
              离开前要保存这次编辑吗？保存会生成一个新版本。
            </p>
            <div className="space-y-2">
              <button
                type="button"
                className="ac-btn w-full px-3 py-2 text-sm"
                disabled={savePhase.kind === "saving"}
                onClick={() => void saveAndExit()}
              >
                {savePhase.kind === "saving" ? "保存中…" : "保存并退出"}
              </button>
              <button
                type="button"
                className="ac-btn-ghost w-full px-3 py-2 text-sm text-high"
                disabled={savePhase.kind === "saving"}
                onClick={discardAndExit}
              >
                放弃更改并退出
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-xs text-ink-faint hover:text-ink"
                disabled={savePhase.kind === "saving"}
                onClick={() => setExitTarget(null)}
              >
                取消
              </button>
            </div>
            {savePhase.kind === "error" && (
              <p className="text-xs text-danger">{savePhase.message}</p>
            )}
          </div>
        </div>
      )}

      <LibrarySaveAsDialog
        open={saveAsOpen}
        originalFilename={docInfo.filename}
        defaultFilename={defaultCopyName(docInfo.filename)}
        sourceType={initial.document.sourceType}
        format={format}
        onClose={() => setSaveAsOpen(false)}
        onSaveToLibrary={saveToLibrary}
        onDownload={exportCopy}
        onSaveAsAttachment={saveAsAttachment}
        onUpdateCurrent={() => {
          if (dirtyRef.current) void saveRef.current({ mode: "manual" });
        }}
        onSaved={(message) => {
          setSavedHint(message);
          window.setTimeout(() => setSavedHint(""), 4000);
        }}
      />
    </div>
  );
}
