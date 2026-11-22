"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileTypeIcon, FolderIcon } from "@/components/file-type-icon";

type SourceSummary = {
  personalCount: number;
  teams: { teamId: string; teamName: string; itemCount: number }[];
};

type FolderRow = {
  folderId: string;
  name: string;
  path: string;
  itemCount: number;
};

type ItemRow = {
  itemId: string;
  filename: string;
  folderPath?: string;
  mimeType: string | null;
  size: number;
  typeLabel: string;
  updatedAt: string;
};

type BrowseView = {
  folder: { folderId: string; name: string; path: string } | null;
  breadcrumbs: { id: string; name: string }[];
  folders: FolderRow[];
  items: ItemRow[];
  searching: boolean;
};

type Scope = { kind: "personal" } | { kind: "team"; teamId: string; name: string };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 助手面板的「从资源库选择附件」。
 *
 * 只负责选一个文件；选中后调 /api/assistant/files/from-library 把它登记成本次对话的
 * assistant 文件，父组件再按普通附件处理（随消息发给模型、可读、可再转发）。
 */
export function AssistantLibraryPicker({
  open,
  onClose,
  onPick,
  full,
}: {
  open: boolean;
  onClose: () => void;
  /** 拿到可用的 assistant 文件；父组件负责加入待发送附件 */
  onPick: (file: {
    id: string;
    filename: string;
    mimeType: string | null;
    size: number;
  }) => void;
  /** 附件已满：禁止再选，但仍可浏览 */
  full: boolean;
}) {
  const [sources, setSources] = useState<SourceSummary | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "personal" });
  const [folderId, setFolderId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  /** 同一个关键词/目录再点一次也要重新拉：单纯 set 同值不会触发 effect */
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<BrowseView | null>(null);
  // 父组件每次打开都重新挂载本组件，初始状态就是「个人库根目录、正在加载」
  const [loading, setLoading] = useState(true);
  const [pickingId, setPickingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void fetch("/api/library/sources")
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | (SourceSummary & { error?: string })
          | null;
        if (!res.ok) throw new Error(data?.error ?? "读取资源库失败");
        if (!cancelled) setSources(data);
      })
      // 来源列表失败不该挡住个人库：团队按钮不显示，目录仍照常浏览
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = ++requestId.current;
    const params = new URLSearchParams({ scope: scope.kind });
    if (scope.kind === "team") params.set("teamId", scope.teamId);
    if (folderId) params.set("folderId", folderId);
    if (appliedQuery) params.set("q", appliedQuery);
    void fetch(`/api/library/browse?${params.toString()}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as
          | (BrowseView & { error?: string })
          | null;
        if (!res.ok) throw new Error(data?.error ?? "读取资源库失败");
        if (id !== requestId.current) return;
        setView(data);
        setError(null);
      })
      .catch((e: unknown) => {
        if (id !== requestId.current) return;
        setError(e instanceof Error ? e.message : "读取资源库失败");
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [open, scope, folderId, appliedQuery, reloadKey]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pickingId) onClose();
    };
    window.addEventListener("keydown", onKey);
    // 与预览弹窗一致：打开期间锁背景滚动
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, pickingId]);

  if (!open) return null;

  /** 切目录 / 搜索前先把加载态点起来：effect 只负责拿数据，不在这里同步 setState */
  function beginLoad() {
    setLoading(true);
    setError(null);
  }

  function switchScope(next: Scope) {
    beginLoad();
    setScope(next);
    setFolderId(null);
    setAppliedQuery("");
    setQuery("");
    setReloadKey((k) => k + 1);
  }

  function openFolder(nextFolderId: string | null) {
    beginLoad();
    setFolderId(nextFolderId);
    setAppliedQuery("");
    setReloadKey((k) => k + 1);
  }

  async function pick(item: ItemRow) {
    if (full || pickingId) return;
    setPickingId(item.itemId);
    setError(null);
    try {
      const res = await fetch("/api/assistant/files/from-library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId: item.itemId }),
      });
      const data = (await res.json().catch(() => null)) as
        | {
            id?: string;
            filename?: string;
            mimeType?: string | null;
            size?: number;
            error?: string;
          }
        | null;
      if (!res.ok || !data?.id) {
        setError(data?.error ?? "添加失败，请重试");
        return;
      }
      onPick({
        id: data.id,
        filename: data.filename ?? item.filename,
        mimeType: data.mimeType ?? item.mimeType,
        size: data.size ?? item.size,
      });
      onClose();
    } catch {
      setError("网络异常，请重试");
    } finally {
      setPickingId(null);
    }
  }

  const crumbs = view?.breadcrumbs ?? [];

  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="从资源库选择附件"
      onClick={() => (!pickingId ? onClose() : undefined)}
    >
      <div
        className="ac-card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-ink">从资源库选择附件</p>
          <button
            type="button"
            disabled={!!pickingId}
            className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-sunken hover:text-ink disabled:opacity-50"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => switchScope({ kind: "personal" })}
            className={`ac-badge ${
              scope.kind === "personal"
                ? "bg-primary text-white"
                : "bg-surface text-ink-soft hover:bg-primary-soft hover:text-primary"
            }`}
          >
            个人资源库
            {sources ? `（${sources.personalCount}）` : ""}
          </button>
          {sources?.teams.map((team) => (
            <button
              key={team.teamId}
              type="button"
              onClick={() =>
                switchScope({ kind: "team", teamId: team.teamId, name: team.teamName })
              }
              className={`ac-badge ${
                scope.kind === "team" && scope.teamId === team.teamId
                  ? "bg-primary text-white"
                  : "bg-surface text-ink-soft hover:bg-primary-soft hover:text-primary"
              }`}
            >
              {team.teamName}（{team.itemCount}）
            </button>
          ))}
        </div>

        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            beginLoad();
            setAppliedQuery(query.trim());
            setReloadKey((k) => k + 1);
          }}
        >
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="按文件名搜索（当前文件夹及子文件夹）"
            maxLength={100}
            className="ac-field min-w-0 flex-1 text-xs"
          />
          <button type="submit" className="ac-btn shrink-0 px-3 py-1.5 text-xs">
            搜索
          </button>
        </form>

        <div className="mt-2 flex flex-wrap items-center gap-1 text-xs text-ink-soft">
          <button
            type="button"
            onClick={() => openFolder(null)}
            className="hover:text-primary"
          >
            根目录
          </button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1">
              <span className="text-ink-faint">/</span>
              {i === crumbs.length - 1 ? (
                <span>{c.name}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => openFolder(c.id)}
                  className="hover:text-primary"
                >
                  {c.name}
                </button>
              )}
            </span>
          ))}
          {appliedQuery && (
            <span className="text-ink-faint">｜搜索「{appliedQuery}」</span>
          )}
        </div>

        <div className="mt-2 min-h-0 flex-1 overflow-y-auto rounded-field border border-line">
          {loading && <p className="p-3 text-xs text-ink-faint">读取中…</p>}
          {!loading && error && <p className="p-3 text-xs text-high">{error}</p>}
          {!loading && !error && view && view.folders.length === 0 && view.items.length === 0 && (
            <p className="p-3 text-xs text-ink-faint">
              {appliedQuery ? "没有匹配的文件或文件夹。" : "这个文件夹是空的。"}
            </p>
          )}
          {!loading && !error && view && (
            <ul className="divide-y divide-line">
              {view.folders.map((folder) => (
                <li key={folder.folderId}>
                  <button
                    type="button"
                    onClick={() => openFolder(folder.folderId)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-sunken"
                  >
                    <FolderIcon className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-ink">{folder.name}</span>
                    <span className="shrink-0 text-ink-faint">{folder.itemCount} 个文件</span>
                  </button>
                </li>
              ))}
              {view.items.map((item) => (
                <li key={item.itemId}>
                  <button
                    type="button"
                    disabled={full || !!pickingId}
                    onClick={() => void pick(item)}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-sunken disabled:opacity-50"
                  >
                    <FileTypeIcon
                      filename={item.filename}
                      mimeType={item.mimeType}
                      className="h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ink">{item.filename}</span>
                      <span className="block truncate text-[11px] text-ink-faint">
                        {item.typeLabel}｜{formatSize(item.size)}
                        {appliedQuery && item.folderPath ? `｜${item.folderPath}` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-primary">
                      {pickingId === item.itemId ? "添加中…" : "选择"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <p className="mt-2 text-[11px] text-ink-faint">
          {full
            ? "本次消息的附件已满，移除一个后再选。"
            : "选择后会作为本次对话的附件，可让助手读取、转发或存进任务。"}
        </p>
      </div>
    </div>,
    document.body,
  );
}
