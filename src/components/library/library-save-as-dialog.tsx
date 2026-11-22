"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isSameEditableFormat } from "@/lib/documents/format";
import { FolderTree } from "./folder-tree";
import { listLibraryDestinationsAction } from "@/app/(app)/library/actions";
import type { LibraryDestination } from "@/app/(app)/library/actions";

export type LibrarySaveInput = {
  filename: string;
  scope: "personal" | "team";
  teamId?: string;
  folderId?: string | null;
};

function defaultCopyName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return `${filename}-副本`;
  return `${filename.slice(0, dot)}-副本${filename.slice(dot)}`;
}

export function LibrarySaveAsDialog({
  open,
  originalFilename,
  defaultFilename,
  sourceType,
  format,
  onClose,
  onSaveToLibrary,
  onDownload,
  onSaveAsAttachment,
  onUpdateCurrent,
  onSaved,
}: {
  open: boolean;
  originalFilename: string;
  defaultFilename?: string;
  sourceType: string;
  format: "text" | "docx" | "sheet" | "pptx";
  onClose: () => void;
  onSaveToLibrary: (input: LibrarySaveInput) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  onDownload: (filename: string) => Promise<boolean>;
  onSaveAsAttachment: (filename: string) => Promise<boolean>;
  onUpdateCurrent: () => void;
  onSaved: (message: string) => void;
}) {
  const [destinations, setDestinations] = useState<LibraryDestination[]>([]);
  const [destKey, setDestKey] = useState("personal");
  const [folderId, setFolderId] = useState<string | null>(null);
  const [filename, setFilename] = useState(defaultFilename ?? defaultCopyName(originalFilename));
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      const res = await listLibraryDestinationsAction();
      if (cancelled) return;
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDestinations(res.data);
      const dest = res.data[0];
      if (dest) {
        setDestKey(dest.key);
        const preferred =
          dest.folders.find((f) => f.name === "手动上传")?.id ?? dest.folders[0]?.id ?? "";
        setFolderId(preferred);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      setFilename(defaultFilename ?? defaultCopyName(originalFilename));
      setError("");
      setBusy("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, defaultFilename, originalFilename]);

  if (!open) return null;

  const dest = destinations.find((d) => d.key === destKey);

  function chooseDest(key: string) {
    setDestKey(key);
    const next = destinations.find((d) => d.key === key);
    setFolderId(next?.folders.find((f) => f.name === "手动上传")?.id ?? next?.folders[0]?.id ?? "");
  }

  function validate(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return "文件名不能为空";
    if (!isSameEditableFormat(originalFilename, trimmed, format)) {
      return "另存为只能使用与原文件相同的扩展名";
    }
    return null;
  }

  async function saveToLibrary() {
    const name = filename.trim();
    const invalid = validate(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    if (!dest) {
      setError("请选择目标资源库");
      return;
    }
    setBusy("library");
    setError("");
    try {
      const res = await onSaveToLibrary({
        filename: name,
        scope: dest.scope,
        teamId: dest.teamId,
        folderId: folderId || null,
      });
      if (!res.ok) {
        setError(res.error ?? "保存失败");
        return;
      }
      onSaved(`已保存到${dest.label}`);
      onClose();
    } finally {
      setBusy("");
    }
  }

  async function download() {
    const name = filename.trim();
    const invalid = validate(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy("download");
    setError("");
    try {
      const ok = await onDownload(name);
      if (ok) onClose();
      else setError("下载失败");
    } finally {
      setBusy("");
    }
  }

  async function saveAsAttachment() {
    const name = filename.trim();
    const invalid = validate(name);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy("attachment");
    setError("");
    try {
      const ok = await onSaveAsAttachment(name);
      if (ok) onClose();
      else setError("另存为附件失败");
    } finally {
      setBusy("");
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] grid place-items-center bg-ink/50 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="ac-dialog-panel w-full max-w-md space-y-3 p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm font-semibold text-ink">另存为 / 下载</p>

        <label className="block text-xs text-ink-soft">
          文件名
          <input
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            className="ac-field mt-1 w-full text-sm"
          />
        </label>

        <label className="block text-xs text-ink-soft">
          目标资源库
          <select
            value={destKey}
            onChange={(e) => chooseDest(e.target.value)}
            className="ac-field mt-1 w-full text-sm"
          >
            {destinations.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>

        <div>
          <p className="mb-1 text-xs text-ink-soft">保存位置</p>
          <FolderTree
            folders={dest?.folders ?? []}
            value={folderId}
            onChange={setFolderId}
            rootLabel="资源库根目录"
          />
        </div>

        {error && <p className="text-xs text-high">{error}</p>}

        <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
          {sourceType === "library_item" && (
            <button
              type="button"
              className="ac-btn-ghost px-2.5 py-1 text-xs"
              disabled={!!busy}
              onClick={() => {
                onUpdateCurrent();
                onClose();
              }}
            >
              更新当前资源库文件
            </button>
          )}
          {sourceType === "task_attachment" && (
            <button
              type="button"
              className="ac-btn-ghost px-2.5 py-1 text-xs"
              disabled={!!busy}
              onClick={() => void saveAsAttachment()}
            >
              {busy === "attachment" ? "保存中…" : "另存为任务附件"}
            </button>
          )}
          <button
            type="button"
            className="ac-btn-ghost px-2.5 py-1 text-xs"
            disabled={!!busy}
            onClick={() => void download()}
          >
            {busy === "download" ? "导出中…" : "仅下载副本"}
          </button>
          <button
            type="button"
            className="ac-btn px-2.5 py-1 text-xs"
            disabled={!!busy}
            onClick={() => void saveToLibrary()}
          >
            {busy === "library" ? "保存中…" : "保存到资源库"}
          </button>
          <button
            type="button"
            className="ac-btn-ghost px-2.5 py-1 text-xs"
            onClick={onClose}
          >
            取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
