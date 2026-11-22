"use client";

import { useEffect, useRef, useState } from "react";
import type { SuperDoc } from "superdoc";
import { clearChunkReloadFlag, reloadOnceForChunkError } from "@/lib/chunk-reload";

/**
 * SuperDoc 的样式由 scripts/build-superdoc-css.mjs 合并到 public/superdoc.css。
 * 不走 Next 的 CSS 管线：它的 `::highlight(...)` 是 CSS Custom Highlight API，
 * Lightning CSS 不认识，会在每次构建刷 8 条伪元素警告。
 */
const CSS_ID = "superdoc-css";

function ensureSuperDocCss(): Promise<void> {
  if (typeof document === "undefined") return Promise.resolve();
  if (document.getElementById(CSS_ID)) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.id = CSS_ID;
    link.rel = "stylesheet";
    link.href = "/superdoc.css";
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

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
  const readOnlyRef = useRef(readOnly);
  const userNameRef = useRef(userName);
  const [error, setError] = useState("");
  const [mountToken, setMountToken] = useState(0);

  useEffect(() => {
    onDirtyRef.current = onDirty;
    onSaveRef.current = onSave;
  }, [onDirty, onSave]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
    userNameRef.current = userName;
  }, [readOnly, userName]);

  // 编辑锁是异步拿到的：readOnly 从 true→false 时不能重建编辑器
  // （SuperDoc 可能已经把 ArrayBuffer 交给 worker，旧 buffer 不能复用），
  // 只切换 documentMode 即可。
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    try {
      instance.setDocumentMode(readOnly ? "viewing" : "editing");
    } catch {
      // 编辑器还没 ready：onReady 里会按最新状态再设一次
    }
  }, [readOnly]);

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
      await ensureSuperDocCss();
      if (cancelled) return;
      const { SuperDoc: SuperDocCtor } = await import("superdoc");
      if (cancelled) return;
      instance = new SuperDocCtor({
        selector: host,
        // 复制一份：SuperDoc 可能把 buffer 转移给 worker，之后重试/重建不能复用
        document: bytes.slice(0),
        documentMode: readOnlyRef.current ? "viewing" : "editing",
        role: "editor",
        user: { name: userNameRef.current },
        ui: {
          toolbar: {
            container: toolbarRef.current ?? undefined,
            // 常用中文字体：写入 DOCX 的 w:rFonts，本机安装了对应字体即可正确显示
            fonts: [
              { label: "宋体", key: "SimSun", props: { style: { fontFamily: "SimSun, 宋体, serif" } } },
              { label: "黑体", key: "SimHei", props: { style: { fontFamily: "SimHei, 黑体, sans-serif" } } },
              { label: "楷体", key: "KaiTi", props: { style: { fontFamily: "KaiTi, 楷体, serif" } } },
              { label: "仿宋", key: "FangSong", props: { style: { fontFamily: "FangSong, 仿宋, serif" } } },
              { label: "微软雅黑", key: "Microsoft YaHei", props: { style: { fontFamily: "'Microsoft YaHei', 微软雅黑, sans-serif" } } },
            ],
          },
        },
        onContentError: ({ error }: { error: unknown }) => {
          console.error("[superdoc] content error", error);
        },
        onException: (payload: unknown) => {
          console.error("[superdoc] exception", payload);
        },
        onReady: ({ superdoc }: { superdoc: SuperDoc }) => {
          readyRef.current = true;
          // 建立期间编辑锁可能已经拿到，按最新状态校准一次
          try {
            superdoc.setDocumentMode(readOnlyRef.current ? "viewing" : "editing");
          } catch {
            // 忽略：下次 readOnly 变化还会再设
          }
          clearChunkReloadFlag();
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
      // 部署后旧 chunk 失效：整页刷新一次即可拿到新构建
      if (reloadOnceForChunkError(e)) return;
      setError(e instanceof Error ? e.message : "Word 编辑器加载失败");
    });

    return () => {
      cancelled = true;
      readyRef.current = false;
      instance?.destroy();
      instanceRef.current = null;
    };
  }, [bytes, mountToken]);

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
      {/* 工具条容器始终存在：编辑锁是异步拿到的，不能在拿到锁后才发现没地方挂工具条 */}
      <div
        ref={toolbarRef}
        className="min-h-9 shrink-0 border-b border-line bg-surface px-2 py-1"
        aria-disabled={readOnly}
      />
      {readOnly && (
        <p className="border-b border-line bg-surface-2 px-3 py-1 text-[11px] text-ink-faint">
          当前为只读模式；拿到编辑锁或获得授权后会自动切换为可编辑。
        </p>
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
