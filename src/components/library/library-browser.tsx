"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { EditDocumentButton } from "@/components/documents/edit-document-button";
import { FileTypeIcon, FolderIcon } from "@/components/file-type-icon";
import { detectEditableFormat } from "@/lib/documents/format";
import { formatShortDateTime } from "@/lib/time";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { uploadFileRaw } from "@/lib/upload-client";
import {
  LIBRARY_FILE_TYPE_LABELS,
  LIBRARY_FILE_TYPES,
  libraryFileTypeLabel,
  type LibraryFileType,
} from "@/lib/library/file-kind";
import {
  ORIGIN_LABELS,
  type LibraryItemView,
  type LibraryOperationView,
  type LibrarySortDir,
  type LibrarySortField,
  type LibraryView,
} from "@/lib/library/types";
import {
  createFolderAction,
  deleteFolderAction,
  deleteItemAction,
  listLibraryDestinationsAction,
  listLibraryFoldersAction,
  moveItemAction,
  renameFolderAction,
  renameItemAction,
  syncLibraryNowAction,
  type FolderOption,
  type LibraryDestination,
} from "@/app/(app)/library/actions";
import { FolderTree } from "./folder-tree";
import { LibraryPreviewDialog } from "./library-preview-dialog";

const OPERATION_LABEL: Record<string, string> = {
  item_created: "创建了文件",
  item_uploaded: "上传了文件",
  item_imported: "汇总了文件",
  item_synced: "同步了文件",
  item_saved_from_agent: "从助手保存了文件",
  item_copied: "复制了文件",
  item_renamed: "重命名了文件",
  item_moved: "移动了文件",
  item_deleted: "删除了文件",
  version_created: "保存了新版本",
  version_deleted: "删除了历史版本",
  version_restored: "恢复了历史版本",
  version_synced: "从来源同步了新版本",
  document_saved: "在线编辑保存",
  document_saved_as: "另存为资源库文件",
  document_collaboration_changed: "切换了协作模式",
  document_editor_granted: "授予了编辑权",
  document_editor_revoked: "撤销了编辑权",
  folder_created: "新建了文件夹",
  folder_renamed: "重命名了文件夹",
  folder_deleted: "删除了文件夹",
  live_follow_detached: "停止跟随来源",
};

const SORT_LABELS: Record<LibrarySortField, string> = {
  name: "名称",
  modified: "修改时间",
  size: "大小",
  type: "类型",
};

// 列表里每一行都是**独立的 grid 容器**：末列若用 auto，各行动作按钮多少不同，
// 会把前面的固定列推得左右错位（表头也和行对不上）。统一固定末列宽，
// 表头与所有行共用同一套轨道，修改时间 / 类型 / 大小严格竖向对齐。
const ROW_GRID =
  "grid-cols-1 sm:grid-cols-[minmax(0,1fr)_9.5rem_7rem_6.5rem_12rem]";

/** 小窗口外壳：点击遮罩取消（busy 时由调用方拦住） */
function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="ac-card max-h-[85vh] w-full max-w-md overflow-y-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-ink">{title}</p>
          <button
            type="button"
            className="grid h-7 w-7 place-items-center rounded text-ink-faint hover:bg-sunken hover:text-ink"
            aria-label="关闭"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 新建 / 重命名共用的小窗：替代浏览器 prompt */
function NameDialog({
  title,
  initial,
  confirmLabel,
  onCancel,
  onSubmit,
}: {
  title: string;
  initial: string;
  confirmLabel: string;
  onCancel: () => void;
  /** 返回 false 表示未成功，窗口保持打开 */
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = name.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onSubmit(value);
    setBusy(false);
    if (ok) onCancel();
  }

  return (
    <Dialog title={title} onClose={() => (!busy ? onCancel() : undefined)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="ac-field w-full text-sm"
          placeholder="名称"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="ac-btn-ghost px-3 py-1.5 text-xs" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="submit" className="ac-btn px-3 py-1.5 text-xs" disabled={busy || !name.trim()}>
            {busy ? "保存中…" : confirmLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function LibraryBrowser({
  scope,
  teamId,
  libraryName,
  view,
  operations,
  timeZone,
}: {
  scope: "personal" | "team";
  teamId?: string;
  libraryName: string;
  view: LibraryView;
  operations: LibraryOperationView[];
  timeZone: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchTimer = useRef<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [search, setSearch] = useState(view.query.q);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [moveItem, setMoveItem] = useState<LibraryItemView | null>(null);
  const [moveFolders, setMoveFolders] = useState<FolderOption[]>([]);
  const [moveDest, setMoveDest] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LibraryItemView | null>(null);
  const [deleteSources, setDeleteSources] = useState(false);
  const [deleteLinkCount, setDeleteLinkCount] = useState(0);
  const [nameDialog, setNameDialog] = useState<{
    title: string;
    initial: string;
    confirmLabel: string;
    onSubmit: (name: string) => Promise<boolean>;
  } | null>(null);
  const [folderDelete, setFolderDelete] = useState<{ id: string; name: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [destinations, setDestinations] = useState<LibraryDestination[]>([]);
  const [destKey, setDestKey] = useState(scope === "team" ? `team:${teamId}` : "personal");
  const [uploadFolderId, setUploadFolderId] = useState<string | null>(null);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);

  // 离开页面时别让防抖中的搜索把用户拉回来
  useEffect(() => {
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, []);

  const basePath = scope === "team" ? `/teams/${teamId}/library` : "/library";
  const type = view.query.type;
  const sort = view.query.sort;
  const dir = view.query.dir;

  function buildHref(
    folderId: string | null,
    overrides: {
      q?: string;
      type?: LibraryFileType;
      sort?: LibrarySortField;
      dir?: LibrarySortDir;
    } = {},
  ): string {
    const params = new URLSearchParams();
    if (folderId) params.set("folder", folderId);
    const q = overrides.q ?? search;
    const t = overrides.type ?? type;
    const s = overrides.sort ?? sort;
    const d = overrides.dir ?? dir;
    if (q.trim()) params.set("q", q.trim());
    if (t !== "all") params.set("type", t);
    if (s !== "modified") params.set("sort", s);
    if (d !== "desc") params.set("dir", d);
    const qs = params.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  }

  function navigate(
    overrides: {
      q?: string;
      type?: LibraryFileType;
      sort?: LibrarySortField;
      dir?: LibrarySortDir;
    } = {},
  ) {
    const href = buildHref(view.folder?.id ?? null, overrides);
    startTransition(() => router.replace(href, { scroll: false }));
  }

  function onSearchChange(value: string) {
    setSearch(value);
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => navigate({ q: value }), 300);
  }

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(label);
    setError("");
    try {
      const res = await fn();
      if (!res.ok) {
        setError(res.error ?? "操作失败");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setError("操作失败，请稍后重试");
      return false;
    } finally {
      setBusy("");
    }
  }

  async function openUpload(files: File[]) {
    if (files.length === 0) return;
    const tooLarge = files.filter((f) => f.size > MAX_FILE_SIZE);
    const empty = files.filter((f) => f.size === 0);
    const valid = files.filter((f) => f.size > 0 && f.size <= MAX_FILE_SIZE);
    if (tooLarge.length > 0 || empty.length > 0) {
      const bits: string[] = [];
      if (empty.length > 0) bits.push(`${empty.length} 个空文件`);
      if (tooLarge.length > 0) bits.push(`${tooLarge.length} 个超过 ${MAX_FILE_SIZE_LABEL} 的文件`);
      setError(`已跳过${bits.join("、")}`);
    }
    if (valid.length === 0) return;
    setError("");
    setUploadFiles(valid);
    setUploadOpen(true);
    setUploading(null);
    setDestKey(scope === "team" && teamId ? `team:${teamId}` : "personal");
    // 默认传到当前浏览的文件夹；在根目录时就是根目录
    setUploadFolderId(view.folder?.id ?? null);
    setDestinations([]);
    const res = await listLibraryDestinationsAction();
    if (res.ok) setDestinations(res.data);
    else setError(res.error);
  }

  async function confirmUpload() {
    if (uploading || uploadFiles.length === 0) return;
    const dest = destinations.find((d) => d.key === destKey);
    if (!dest) return;
    setError("");
    setUploading({ done: 0, total: uploadFiles.length });
    for (let i = 0; i < uploadFiles.length; i++) {
      const res = await uploadFileRaw<{ id: string }>("/api/library/upload", uploadFiles[i], {
        scope: dest.scope,
        ...(dest.teamId ? { teamId: dest.teamId } : {}),
        folderId: uploadFolderId ?? "root",
      });
      if (!res.ok) {
        setError(res.error);
        setUploading(null);
        return;
      }
      setUploading({ done: i + 1, total: uploadFiles.length });
    }
    setUploading(null);
    setUploadOpen(false);
    setUploadFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    router.refresh();
  }

  function newFolder() {
    setNameDialog({
      title: "新建文件夹",
      initial: "",
      confirmLabel: "新建",
      onSubmit: (name) =>
        run("folder", () =>
          createFolderAction({
            scope,
            teamId,
            parentId: view.folder?.id ?? null,
            name,
          }),
        ),
    });
  }

  function renameFolder(id: string, current: string) {
    setNameDialog({
      title: "重命名文件夹",
      initial: current,
      confirmLabel: "保存",
      onSubmit: (name) =>
        name === current ? Promise.resolve(true) : run("folder", () => renameFolderAction(id, name)),
    });
  }

  function removeFolder(id: string, name: string) {
    setFolderDelete({ id, name });
  }

  async function confirmFolderDelete(mode: "delete-all" | "keep-files") {
    if (!folderDelete || busy) return;
    const ok = await run("folder", () => deleteFolderAction(folderDelete.id, mode));
    if (ok) setFolderDelete(null);
  }

  function renameItem(item: LibraryItemView) {
    setNameDialog({
      title: "重命名文件",
      initial: item.filename,
      confirmLabel: "保存",
      onSubmit: (name) =>
        name === item.filename ? Promise.resolve(true) : run("item", () => renameItemAction(item.id, name)),
    });
  }

  async function openMove(item: LibraryItemView) {
    setMoveItem(item);
    setMoveDest(item.folderId);
    setError("");
    setMoveFolders([]);
    const res = await listLibraryFoldersAction(scope, teamId);
    if (res.ok) setMoveFolders(res.data);
    else setError(res.error);
  }

  async function confirmMove() {
    if (!moveItem || busy) return;
    const ok = await run("item", () => moveItemAction(moveItem.id, moveDest));
    if (ok) setMoveItem(null);
  }

  function goUp() {
    if (!view.folder) return;
    startTransition(() =>
      router.replace(buildHref(view.folder?.parentId ?? null), { scroll: false }),
    );
  }

  async function openDelete(item: LibraryItemView) {
    setDeleteTarget(item);
    setDeleteSources(false);
    setDeleteLinkCount(0);
    setError("");
    const res = await fetch(`/api/library/items/${item.id}`);
    if (res.ok) {
      const detail = (await res.json()) as { links?: unknown[] };
      setDeleteLinkCount(detail.links?.length ?? 0);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const res = await run("item", () =>
      deleteItemAction(deleteTarget.id, { deleteSources }),
    );
    if (res) {
      setDeleteTarget(null);
      setDeleteSources(false);
    }
  }

  const fileCount = view.items.length;
  const folderCount = view.folders.length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {view.folder && (
          <button
            type="button"
            className="ac-btn-ghost shrink-0 px-2.5 py-1 text-xs"
            onClick={goUp}
            title="返回上一级文件夹"
          >
            ← 上一级
          </button>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm text-ink-soft">
          <Link href={buildHref(null)} className="hover:text-primary">
            {libraryName}
          </Link>
          {view.breadcrumbs.map((crumb) => (
            <span key={crumb.id} className="flex items-center gap-1.5">
              <span className="text-ink-faint">/</span>
              <Link href={buildHref(crumb.id)} className="hover:text-primary">
                {crumb.name}
              </Link>
            </span>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {view.canEdit && (
            <>
              <button
                type="button"
                className="ac-btn-ghost px-2.5 py-1 text-xs"
                disabled={!!busy}
                onClick={() => void newFolder()}
              >
                新建文件夹
              </button>
              <button
                type="button"
                className="ac-btn px-2.5 py-1 text-xs"
                disabled={!!busy}
                onClick={() => fileInputRef.current?.click()}
              >
                上传文件
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.currentTarget.value = "";
                  void openUpload(files);
                }}
              />
            </>
          )}
          <button
            type="button"
            className="ac-btn-ghost px-2.5 py-1 text-xs"
            disabled={!!busy}
            onClick={() => void run("sync", () => syncLibraryNowAction(scope, teamId))}
          >
            {busy === "sync" ? "同步中…" : "立即同步"}
          </button>
        </div>
      </div>

      {!view.canEdit && (
        <p className="ac-card p-3 text-xs text-ink-soft">
          教师可查看团队资源库；如需编辑，请联系团队管理员调整角色，或使用个人资源库。
        </p>
      )}
      {error && <p className="text-sm text-high">{error}</p>}

      {/* Windows 资源管理器式工具栏：类型在左、搜索居中、排序与升降序成组靠右 */}
      <div className="ac-card flex flex-wrap items-center gap-2 p-2.5">
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-ink-faint">
          文件类型
          <select
            value={type}
            onChange={(e) => navigate({ type: e.target.value as LibraryFileType })}
            aria-label="按文件类型筛选"
            className="ac-field min-w-[5.5rem] py-1.5 text-xs"
          >
            {LIBRARY_FILE_TYPES.map((t) => (
              <option key={t} value={t}>
                {LIBRARY_FILE_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <div className="relative min-w-[10rem] max-w-xl flex-1">
          <span
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          >
            🔍
          </span>
          <input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                if (searchTimer.current) window.clearTimeout(searchTimer.current);
                navigate({ q: search });
              }
            }}
            placeholder="搜索文件名…"
            title="搜索当前文件夹及子文件夹"
            aria-label="搜索资源库文件"
            className="ac-field w-full py-1.5 pl-8 pr-8 text-sm"
          />
          {search && (
            <button
              type="button"
              aria-label="清空搜索"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
              onClick={() => {
                setSearch("");
                navigate({ q: "" });
              }}
            >
              ×
            </button>
          )}
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-xs text-ink-faint">
            排序方式
            <select
              value={sort}
              onChange={(e) => navigate({ sort: e.target.value as LibrarySortField })}
              aria-label="排序方式"
              className="ac-field min-w-[6rem] py-1.5 text-xs"
            >
              {(Object.keys(SORT_LABELS) as LibrarySortField[]).map((field) => (
                <option key={field} value={field}>
                  按{SORT_LABELS[field]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="ac-btn-ghost whitespace-nowrap px-2.5 py-1.5 text-xs"
            onClick={() => navigate({ dir: dir === "asc" ? "desc" : "asc" })}
            title={dir === "asc" ? "当前升序，点击切为降序" : "当前降序，点击切为升序"}
          >
            {dir === "asc" ? "↑ 升序" : "↓ 降序"}
          </button>
          {pending && <span className="text-xs text-ink-faint">搜索中…</span>}
        </div>
      </div>

      <p className="text-xs text-ink-faint">
        {view.searching ? "搜索结果" : "当前文件夹"}：{folderCount} 个文件夹 · {fileCount} 个文件
        {view.searching && view.query.q ? ` · 关键词「${view.query.q}」` : ""}
        {view.searching && view.query.type !== "all"
          ? ` · ${LIBRARY_FILE_TYPE_LABELS[view.query.type]}`
          : ""}
      </p>

      <div className="ac-card overflow-hidden p-0">
        <div
          className={`hidden gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-[11px] font-medium text-ink-faint sm:grid ${ROW_GRID}`}
        >
          <span>名称</span>
          <span>修改时间</span>
          <span>类型</span>
          <span className="text-right">大小 / 数量</span>
          <span className="text-right">操作</span>
        </div>

        {folderCount === 0 && fileCount === 0 ? (
          <p className="p-5 text-sm text-ink-faint">
            {view.searching
              ? "没有找到匹配的文件或文件夹。"
              : scope === "personal"
                ? "个人资源库还没有文件。任务附件、私信文件、群文件与助手生成的文件会汇总到这里，也可以直接上传。"
                : "团队资源库还没有文件。团队成员上传的任务附件会自动汇总到这里。"}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {view.folders.map((folder) => (
              <li
                key={folder.id}
                className={`group relative grid items-start gap-1 px-3 py-2 hover:bg-sunken sm:gap-2 ${ROW_GRID}`}
              >
                <div className="flex min-w-0 items-start gap-2">
                  <FolderIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    {/* 覆盖层挂在不带 overflow:hidden 的 Link 上，整行都可点；
                        truncate 放在内层 span，否则 ::after 会被一起裁掉 */}
                    <Link
                      href={buildHref(folder.id)}
                      className="block max-w-full text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] hover:text-primary"
                      title={folder.name}
                    >
                      <span className="block truncate">{folder.name}</span>
                    </Link>
                    {view.searching && folder.path && (
                      <span className="block truncate text-[11px] text-ink-faint">
                        {folder.path}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs leading-5 text-ink-faint">
                  {formatShortDateTime(timeZone, folder.updatedAt)}
                </span>
                <span className="text-xs leading-5 text-ink-soft">文件夹</span>
                <span className="text-xs leading-5 text-ink-faint sm:text-right">
                  {folder.itemCount} 个文件
                </span>
                {/* z-10：压在整行覆盖层之上，否则改名/删除会先触发打开文件夹；
                    容器本身放行指针事件，让右侧留白也能点开整行 */}
                <div className="pointer-events-none relative z-10 flex justify-end gap-2 text-xs [&>*]:pointer-events-auto">
                  {view.canEdit && !folder.isDefault && (
                    <>
                      <button
                        type="button"
                        className="text-ink-faint hover:text-primary"
                        onClick={() => void renameFolder(folder.id, folder.name)}
                      >
                        改名
                      </button>
                      <button
                        type="button"
                        className="text-ink-faint hover:text-high"
                        onClick={() => void removeFolder(folder.id, folder.name)}
                      >
                        删除
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}

            {view.items.map((item) => {
              const editInfo = detectEditableFormat(item.filename, item.mimeType, item.size);
              const modifiedAt = item.currentCreatedAt ?? item.updatedAt;
              return (
                <li
                  key={item.id}
                  className={`group relative grid items-start gap-1 px-3 py-2 hover:bg-sunken sm:gap-2 ${ROW_GRID}`}
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <FileTypeIcon
                      filename={item.filename}
                      mimeType={item.mimeType}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setPreviewId(item.id)}
                        className="block max-w-full text-left text-sm text-ink after:absolute after:inset-0 after:content-[''] hover:text-primary"
                        title={item.filename}
                      >
                        <span className="block truncate">{item.filename}</span>
                      </button>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
                        <span className="ac-badge bg-sunken text-ink-soft">
                          {ORIGIN_LABELS[item.origin] ?? item.origin}
                        </span>
                        {item.live && (
                          <span className="ac-badge bg-primary-soft text-primary">
                            实时跟进
                          </span>
                        )}
                        <span className="text-[11px] text-ink-faint">
                          v{item.currentVersion} · {item.versionCount} 个版本
                        </span>
                        {view.searching && item.folderPath && (
                          <span className="text-[11px] text-ink-faint">
                            · {item.folderPath}
                          </span>
                        )}
                      </span>
                    </div>
                  </div>
                  <span className="text-xs leading-5 text-ink-faint">
                    {formatShortDateTime(timeZone, new Date(modifiedAt))}
                    <span className="block truncate text-[11px]">
                      {item.currentActorName ?? "未知用户"}
                    </span>
                  </span>
                  <span className="text-xs leading-5 text-ink-soft">
                    {libraryFileTypeLabel(item.filename, item.mimeType)}
                  </span>
                  <span className="text-xs leading-5 text-ink-faint sm:text-right">
                    {fmtSize(item.size)}
                  </span>
                  <div className="pointer-events-none relative z-10 flex flex-wrap justify-end gap-2 text-xs [&>*]:pointer-events-auto">
                    <button
                      type="button"
                      className="text-primary underline"
                      onClick={() => setPreviewId(item.id)}
                    >
                      预览
                    </button>
                    {view.canEdit && editInfo.editable && (
                      <EditDocumentButton
                        sourceType="library_item"
                        sourceId={item.id}
                        label="编辑"
                        className="text-xs text-primary underline"
                      />
                    )}
                    <a
                      href={`/api/library/items/${item.id}/content`}
                      download={item.filename}
                      className="text-primary underline"
                    >
                      下载
                    </a>
                    {view.canEdit && (
                      <>
                        <button
                          type="button"
                          className="text-ink-soft underline"
                          onClick={() => void renameItem(item)}
                        >
                          改名
                        </button>
                        <button
                          type="button"
                          className="text-ink-soft underline"
                          onClick={() => void openMove(item)}
                        >
                          移动
                        </button>
                        <button
                          type="button"
                          className="text-high underline"
                          onClick={() => void openDelete(item)}
                        >
                          删除
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <section className="ac-card overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <h2 className="text-sm font-semibold text-ink">操作日志</h2>
          <span className="text-xs text-ink-faint">{operations.length} 条</span>
        </div>
        <div className="h-48 overflow-y-auto overscroll-contain px-4 py-2.5">
          <ul className="space-y-1.5 pr-1">
            {operations.map((op) => (
              <li key={op.id} className="text-xs text-ink-soft">
                <span className="font-medium text-ink">{op.actorName}</span>{" "}
                {OPERATION_LABEL[op.type] ?? op.type}
                {op.newValue ? `「${op.newValue}」` : ""}
                <span className="ml-1 text-ink-faint">
                  {op.note ? `· ${op.note} ` : ""}
                  {formatShortDateTime(timeZone, new Date(op.createdAt))}
                </span>
              </li>
            ))}
            {operations.length === 0 && (
              <li className="text-xs text-ink-faint">暂无操作记录。</li>
            )}
          </ul>
        </div>
      </section>

      {previewId && (
        <LibraryPreviewDialog
          itemId={previewId}
          timeZone={timeZone}
          onClose={() => setPreviewId(null)}
        />
      )}

      {moveItem && (
        <Dialog
          title={`移动「${moveItem.filename}」`}
          onClose={() => (!busy ? setMoveItem(null) : undefined)}
        >
          <p className="mb-1 text-xs text-ink-faint">选择目标文件夹</p>
          {moveFolders.length === 0 ? (
            <p className="rounded-field border border-line p-3 text-sm text-ink-faint">
              正在加载文件夹…
            </p>
          ) : (
            <FolderTree
              folders={moveFolders}
              value={moveDest}
              onChange={setMoveDest}
              rootLabel={`${libraryName} · 根目录`}
              disabledId={moveItem.folderId}
            />
          )}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              className="ac-btn-ghost px-3 py-1.5 text-sm"
              onClick={() => setMoveItem(null)}
              disabled={!!busy}
            >
              取消
            </button>
            <button
              type="button"
              className="ac-btn px-3 py-1.5 text-sm"
              onClick={() => void confirmMove()}
              disabled={!!busy || moveFolders.length === 0}
            >
              {busy === "item" ? "移动中…" : "移动到这里"}
            </button>
          </div>
        </Dialog>
      )}

      {uploadOpen && (
        <Dialog
          title="上传文件"
          onClose={() => {
            if (uploading) return;
            setUploadOpen(false);
            setUploadFiles([]);
          }}
        >
          <div className="space-y-3">
            <label className="block text-xs text-ink-faint">
              上传到
              <select
                className="ac-field mt-1 w-full text-sm"
                value={destKey}
                disabled={!!uploading}
                onChange={(e) => {
                  setDestKey(e.target.value);
                  setUploadFolderId(null);
                }}
              >
                {destinations.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>

            <div>
              <p className="mb-1 text-xs text-ink-faint">目标文件夹</p>
              {destinations.length === 0 ? (
                <p className="rounded-field border border-line p-3 text-sm text-ink-faint">
                  正在加载资源库…
                </p>
              ) : (
                <FolderTree
                  folders={
                    destinations.find((d) => d.key === destKey)?.folders ?? []
                  }
                  value={uploadFolderId}
                  onChange={setUploadFolderId}
                  rootLabel="资源库根目录"
                />
              )}
            </div>

            <ul className="max-h-24 space-y-1 overflow-y-auto rounded-field border border-line p-2 text-xs text-ink-soft">
              {uploadFiles.map((f, i) => (
                <li key={`${i}-${f.name}`} className="flex justify-between gap-2">
                  <span className="truncate">{f.name}</span>
                  <span className="shrink-0 text-ink-faint">{fmtSize(f.size)}</span>
                </li>
              ))}
            </ul>

            {error && <p className="text-sm text-high">{error}</p>}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="ac-btn-ghost px-3 py-1.5 text-sm"
                disabled={!!uploading}
                onClick={() => {
                  setUploadOpen(false);
                  setUploadFiles([]);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="ac-btn px-3 py-1.5 text-sm"
                disabled={!!uploading || destinations.length === 0}
                onClick={() => void confirmUpload()}
              >
                {uploading
                  ? `上传中 ${uploading.done}/${uploading.total}…`
                  : `上传 ${uploadFiles.length} 个文件`}
              </button>
            </div>
          </div>
        </Dialog>
      )}

      {nameDialog && (
        <NameDialog
          title={nameDialog.title}
          initial={nameDialog.initial}
          confirmLabel={nameDialog.confirmLabel}
          onCancel={() => setNameDialog(null)}
          onSubmit={nameDialog.onSubmit}
        />
      )}

      {folderDelete && (
        <Dialog
          title={`删除文件夹「${folderDelete.name}」`}
          onClose={() => (!busy ? setFolderDelete(null) : undefined)}
        >
          <p className="text-sm text-ink-soft">请选择里面内容的处理方式：</p>
          <div className="mt-3 space-y-2">
            <button
              type="button"
              className="ac-btn-ghost block w-full rounded-field p-3 text-left"
              disabled={!!busy}
              onClick={() => void confirmFolderDelete("keep-files")}
            >
              <span className="block text-sm text-ink">只删除文件夹，内容移到上一级</span>
              <span className="block text-xs text-ink-faint">
                文件和子文件夹都会保留，只是挪到上一级目录
              </span>
            </button>
            <button
              type="button"
              className="ac-btn-ghost block w-full rounded-field p-3 text-left"
              disabled={!!busy}
              onClick={() => void confirmFolderDelete("delete-all")}
            >
              <span className="block text-sm text-high">连同里面的文件和子文件夹一起删除</span>
              <span className="block text-xs text-ink-faint">
                不可恢复，文件的历史版本也会一并删除
              </span>
            </button>
          </div>
          <div className="mt-3 flex justify-end">
            <button
              type="button"
              className="ac-btn-ghost px-3 py-1.5 text-sm"
              disabled={!!busy}
              onClick={() => setFolderDelete(null)}
            >
              {busy === "folder" ? "处理中…" : "取消"}
            </button>
          </div>
        </Dialog>
      )}

      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="alertdialog"
          aria-modal="true"
          onClick={() => setDeleteTarget(null)}
        >
          <div className="ac-card w-full max-w-md p-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-semibold text-ink">
              删除「{deleteTarget.filename}」
            </p>
            <p className="mt-1 text-xs text-ink-soft">
              将删除该文件在资源库中的全部历史版本。默认只删资源库记录，原始任务附件/私信/助手文件不受影响。
            </p>
            {deleteLinkCount > 0 && (
              <label className="mt-3 flex items-start gap-2 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={deleteSources}
                  onChange={(e) => setDeleteSources(e.target.checked)}
                />
                <span>
                  同时删除来源文件（{deleteLinkCount} 个来源；仅任务附件与助手文件可删，私信/群聊附件会保留）
                </span>
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="ac-btn-ghost px-3 py-1.5 text-sm"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="ac-btn px-3 py-1.5 text-sm"
                disabled={!!busy}
                onClick={() => void confirmDelete()}
              >
                {busy === "item" ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
