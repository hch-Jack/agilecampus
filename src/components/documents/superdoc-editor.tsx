"use client";

import { useEffect, useRef, useState } from "react";
import type { SuperDoc } from "superdoc";
import "superdoc/style.css";

/**
 * Word 编辑：直接交给 SuperDoc（浏览器内 DOCX/OOXML 编辑器）。
 *
 * 与旧实现（mammoth 转语义 HTML → Tiptap → 重新生成 docx）不同，SuperDoc
 * 在 OOXML 上编辑，导出时也是一份 .docx，因此原文件的字体、字号、颜色、
 * 页边距、页眉页脚等排版可以保留。保存由父组件走 save-docx（原始字节），
 * 不再经过 HTML/Tiptap 重建。
 */

export type SuperDocEditorApi = {
  /** 导出当前文档的 .docx 字节；编辑器未就绪时返回 null */
  getBytes: () => Promise<Uint8Array | null>;
  markClean: () => void;
  isDirty: () => boolean;
};

export function SuperDocEditor({
  bytes,
  readOnly,
  filename,
  userName,
  apiRef,
  onDirty,
  onSave,
}: {
  bytes: ArrayBuffer | null;
  readOnly: boolean;
  filename: string;
  userName: string;
  apiRef: { current: SuperDocEditorApi | null };
  onDirty: () => void;
  onSave: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<SuperDoc | null>(null);
  const dirtyRef = useRef(false);
  const readyRef = useRef(false);
  // 只有用户真的碰过编辑器，才把 editor-update 当成修改：
  // 初次装载/字体回填等程序化更新不算脏数据，避免一打开就自动保存。
  const interactedRef = useRef(false);
  const onDirtyRef = useRef(onDirty);
  const onSaveRef = useRef(onSave);
  const [error, setError] = useState("");
  const [mountToken, setMountToken] = useState(0);

  useEffect(() => {
    onDirtyRef.current = onDirty;
    onSaveRef.current = onSave;
  }, [onDirty, onSave]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const mark = () => {
      interactedRef.current = true;
    };
    root.addEventListener("pointerdown", mark, true);
    root.addEventListener("keydown", mark, true);
    return () => {
      root.removeEventListener("pointerdown", mark, true);
      root.removeEventListener("keydown", mark, true);
    };
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !bytes) return;
    let cancelled = false;
    let instance: SuperDoc | null = null;
    dirtyRef.current = false;
    readyRef.current = false;
    interactedRef.current = false;
    setError("");

    void (async () => {
      const { SuperDoc: SuperDocCtor } = await import("superdoc");
      if (cancelled) return;
      instance = new SuperDocCtor({
        selector: host,
        document: bytes,
        documentMode: readOnly ? "viewing" : "editing",
        role: readOnly ? "viewer" : "editor",
        user: { name: userName },
        // 只读时不渲染工具条；可编辑时把工具条放到页面自己的头部下方
        ui: readOnly
          ? { toolbar: false, comments: false }
          : {
              toolbar: {
                container: toolbarRef.current ?? undefined,
              },
            },
        onReady: () => {
          readyRef.current = true;
        },
      });
      instance.on("editor-update", () => {
        // ready 之前、或用户尚未操作过时的更新都不算修改
        if (!readyRef.current || !interactedRef.current) return;
        dirtyRef.current = true;
        onDirtyRef.current();
      });
      instanceRef.current = instance;
    })().catch((e: unknown) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : "Word 编辑器加载失败");
    });

    return () => {
      cancelled = true;
      readyRef.current = false;
      instance?.destroy();
      instanceRef.current = null;
    };
  }, [bytes, readOnly, userName, mountToken]);

  // 父组件的保存流程从这里取当前 DOCX 字节
  useEffect(() => {
    apiRef.current = {
      getBytes: async () => {
        const instance = instanceRef.current;
        if (!instance) return null;
        const blob = await instance.export({ triggerDownload: false });
        return new Uint8Array(await blob.arrayBuffer());
      },
      markClean: () => {
        dirtyRef.current = false;
      },
      isDirty: () => dirtyRef.current,
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSaveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [readOnly]);

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {!readOnly && (
        <div
          ref={toolbarRef}
          className="min-h-9 shrink-0 border-b border-line bg-surface px-2 py-1"
        />
      )}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-sunken/40">
        <div ref={hostRef} className="h-full overflow-auto" title={filename} />
        {error && (
          <div className="absolute inset-0 grid place-items-center bg-surface p-6 text-center">
            <div>
              <p className="text-sm text-danger">{error}</p>
              <button
                type="button"
                className="ac-btn mt-3 px-3 py-1.5 text-xs"
                onClick={() => setMountToken((t) => t + 1)}
              >
                重新加载编辑器
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
