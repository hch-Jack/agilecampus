"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { EditDocumentButton } from "@/components/documents/edit-document-button";
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
  listLibraryFoldersAction,
  moveItemAction,
  renameFolderAction,
  renameItemAction,
  syncLibraryNowAction,
  type FolderOption,
} from "@/app/(app)/library/actions";
import { LibraryPreviewDialog } from "./library-preview-dialog";

const OPERATION_LABEL: Record<string, string> = {
  item_created: "创建了文件",
  item_uploaded: "上传了文件",
  item_imported: "汇总了文件",
  item_synced: "同步了文件",
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
  const [deleteTarget, setDeleteTarget] = useState<LibraryItemView | null>(null);
  const [deleteSources, setDeleteSources] = useState(false);
  const [deleteLinkCount, setDeleteLinkCount] = useState(0);

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

  async function upload(file: File | undefined) {
    if (!file) return;
    if (file.size === 0) {
      setError("不能上传空文件");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(`附件不能超过 ${MAX_FILE_SIZE_LABEL}`);
      return;
    }
    setBusy("upload");
    setError("");
    const res = await uploadFileRaw<{ id: string }>("/api/library/upload", file, {
      scope,
      ...(teamId ? { teamId } : {}),
      ...(view.folder ? { folderId: view.folder.id } : {}),
    });
    setBusy("");
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
    router.refresh();
  }

  async function newFolder() {
    const name = window.prompt("新建文件夹名称")?.trim();
    if (!name) return;
    await run("folder", () =>
      createFolderAction({
        scope,
        teamId,
        parentId: view.folder?.id ?? null,
        name,
      }),
    );
  }

  async function renameFolder(id: string, current: string) {
    const name = window.prompt("文件夹新名称", current)?.trim();
    if (!name || name === current) return;
    await run("folder", () => renameFolderAction(id, name));
  }

  async function removeFolder(id: string, name: string) {
    if (!confirm(`删除文件夹「${name}」？只能删除空文件夹。`)) return;
    await run("folder", () => deleteFolderAction(id));
  }

  async function renameItem(item: LibraryItemView) {
    const name = window.prompt("文件新名称", item.filename)?.trim();
    if (!name || name === item.filename) return;
    await run("item", () => renameItemAction(item.id, name));
  }

  async function openMove(item: LibraryItemView) {
    setMoveItem(item);
    setError("");
    const res = await listLibraryFoldersAction(scope, teamId);
    if (res.ok) setMoveFolders(res.data);
    else setError(res.error);
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
                {busy === "upload" ? "上传中…" : "上传文件"}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={(e) => void upload(e.target.files?.[0])}
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

      {/* Windows 资源管理器式工具栏：搜索 + 类型 + 排序 */}
      <div className="ac-card flex flex-wrap items-center gap-2 p-2.5">
        <div className="relative min-w-[12rem] flex-1">
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
            placeholder="搜索当前文件夹及子文件夹…"
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
        <select
          value={type}
          onChange={(e) => navigate({ type: e.target.value as LibraryFileType })}
          aria-label="按文件类型筛选"
          className="ac-field py-1.5 text-xs"
        >
          {LIBRARY_FILE_TYPES.map((t) => (
            <option key={t} value={t}>
              {LIBRARY_FILE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => navigate({ sort: e.target.value as LibrarySortField })}
          aria-label="排序方式"
          className="ac-field py-1.5 text-xs"
        >
          {(Object.keys(SORT_LABELS) as LibrarySortField[]).map((field) => (
            <option key={field} value={field}>
              按{SORT_LABELS[field]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ac-btn-ghost px-2.5 py-1.5 text-xs"
          onClick={() => navigate({ dir: dir === "asc" ? "desc" : "asc" })}
          title={dir === "asc" ? "当前升序，点击切为降序" : "当前降序，点击切为升序"}
        >
          {dir === "asc" ? "↑ 升序" : "↓ 降序"}
        </button>
        {pending && <span className="text-xs text-ink-faint">搜索中…</span>}
      </div>

      <p className="text-xs text-ink-faint">
        {view.searching ? "搜索结果" : "当前文件夹"}：{folderCount} 个文件夹 · {fileCount} 个文件
        {view.searching && view.query.q ? ` · 关键词「${view.query.q}」` : ""}
        {view.searching && view.query.type !== "all"
          ? ` · ${LIBRARY_FILE_TYPE_LABELS[view.query.type]}`
          : ""}
      </p>

      <div className="ac-card overflow-hidden p-0">
        <div className="hidden grid-cols-[minmax(0,1fr)_9.5rem_7rem_6.5rem_auto] gap-2 border-b border-line bg-surface-2 px-3 py-1.5 text-[11px] font-medium text-ink-faint sm:grid">
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
                className="group grid grid-cols-1 items-center gap-1 px-3 py-2 hover:bg-sunken sm:grid-cols-[minmax(0,1fr)_9.5rem_7rem_6.5rem_auto] sm:gap-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className="text-base">
                    📁
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={buildHref(folder.id)}
                      className="block truncate text-sm font-medium text-ink hover:text-primary"
                      title={folder.name}
                    >
                      {folder.name}
                    </Link>
                    {view.searching && folder.path && (
                      <span className="block truncate text-[11px] text-ink-faint">
                        {folder.path}
                      </span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-ink-faint">
                  {formatShortDateTime(timeZone, folder.updatedAt)}
                </span>
                <span className="text-xs text-ink-soft">文件夹</span>
                <span className="text-xs text-ink-faint sm:text-right">
                  {folder.itemCount} 个文件
                </span>
                <div className="flex justify-end gap-2 text-xs">
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
                  className="group grid grid-cols-1 items-center gap-1 px-3 py-2 hover:bg-sunken sm:grid-cols-[minmax(0,1fr)_9.5rem_7rem_6.5rem_auto] sm:gap-2"
                >
                  <div className="flex min-w-0 items-start gap-2">
                    <span aria-hidden className="mt-0.5 text-base">
                      📄
                    </span>
                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => setPreviewId(item.id)}
                        className="block max-w-full truncate text-left text-sm text-ink hover:text-primary"
                        title={item.filename}
                      >
                        {item.filename}
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
                  <span className="text-xs text-ink-faint">
                    {formatShortDateTime(timeZone, new Date(modifiedAt))}
                    <span className="block truncate text-[11px]">
                      {item.currentActorName ?? "未知用户"}
                    </span>
                  </span>
                  <span className="text-xs text-ink-soft">
                    {libraryFileTypeLabel(item.filename, item.mimeType)}
                  </span>
                  <span className="text-xs text-ink-faint sm:text-right">
                    {fmtSize(item.size)}
                  </span>
                  <div className="flex flex-wrap justify-end gap-2 text-xs">
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

      <section className="ac-card p-4">
        <h2 className="text-sm font-semibold text-ink">操作日志</h2>
        <ul className="mt-2 space-y-1.5">
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
      </section>

      {previewId && (
        <LibraryPreviewDialog
          itemId={previewId}
          timeZone={timeZone}
          onClose={() => setPreviewId(null)}
        />
      )}

      {moveItem && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setMoveItem(null)}
        >
          <div className="ac-card w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium text-ink">移动「{moveItem.filename}」</p>
            <select
              className="ac-field mt-3 w-full text-sm"
              defaultValue=""
              onChange={(e) => {
                const folderId = e.target.value;
                if (!folderId) return;
                void run("item", () => moveItemAction(moveItem.id, folderId)).then((ok) => {
                  if (ok) setMoveItem(null);
                });
              }}
            >
              <option value="">选择目标文件夹…</option>
              {moveFolders
                .filter((f) => f.id !== moveItem.folderId)
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    {" ".repeat(f.depth * 2)}
                    {f.name}
                  </option>
                ))}
            </select>
            <div className="mt-3 flex justify-end">
              <button
                type="button"
                className="ac-btn-ghost px-3 py-1.5 text-sm"
                onClick={() => setMoveItem(null)}
              >
                取消
              </button>
            </div>
          </div>
        </div>
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
