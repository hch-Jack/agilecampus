"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { XlsxAsyncEditorApi } from "@betteroffice/xlsx-react";
import { clearChunkReloadFlag, reloadOnceForChunkError } from "@/lib/chunk-reload";

/**
 * Excel 在线编辑：BetterOffice XLSX 引擎（Apache-2.0）。
 *
 * 与之前自绘的单元格网格相比，自带选择/合并单元格/字体、字号、颜色、
 * 边框、对齐、数字格式等完整表格编辑能力，并在 OOXML 上写回文件。
 */
const XlsxEditor = dynamic(
  () => import("@betteroffice/xlsx-react").then((m) => m.XlsxEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-ink-faint">
        正在加载表格编辑器…
      </div>
    ),
  },
);

export type XlsxEditorApi = {
  getBytes: () => Promise<Uint8Array | null>;
  markClean: () => void;
  isDirty: () => boolean;
  /** Markdown 形式的工作表内容（AI 上下文） */
  getMarkdown: () => Promise<string>;
  /** 把 AI 单元格修改暂存为待审阅提案 */
  stageAiEdits: (input: {
    summary: string;
    cells: { sheet?: number; a1: string; input: string }[];
  }) => Promise<{ staged: number; failed: string[] }>;
};

function a1ToRowCol(a1: string): { row: number; col: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(a1.trim());
  if (!match) return null;
  let col = 0;
  for (const ch of match[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(match[2]) - 1, col: col - 1 };
}

export function XlsxEditorHost({
  bytes,
  reloadToken,
  readOnly,
  filename,
  apiRef,
  onDirty,
  onSave,
}: {
  bytes: ArrayBuffer | null;
  reloadToken: number;
  readOnly: boolean;
  filename: string;
  apiRef: { current: XlsxEditorApi | null };
  onDirty: () => void;
  onSave: () => void;
}) {
  const [error, setError] = useState("");
  const instanceRef = useRef<XlsxAsyncEditorApi | null>(null);
  const dirtyRef = useRef(false);
  const onDirtyRef = useRef(onDirty);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onDirtyRef.current = onDirty;
    onSaveRef.current = onSave;
  }, [onDirty, onSave]);

  useEffect(() => {
    apiRef.current = {
      getBytes: async () => {
        const api = instanceRef.current;
        if (!api) return null;
        return api.save();
      },
      markClean: () => {
        dirtyRef.current = false;
      },
      isDirty: () => dirtyRef.current,
      getMarkdown: async () => {
        const api = instanceRef.current;
        if (!api) return "";
        const res = await api.exportMarkdown();
        return res.ok ? res.content.markdown : "";
      },
      stageAiEdits: async ({ summary, cells }) => {
        const api = instanceRef.current;
        if (!api) throw new Error("表格编辑器尚未就绪");
        if (!api.proposeChanges) throw new Error("当前表格编辑器不支持待确认修改");
        const failed: string[] = [];
        const edits = cells.flatMap((cell) => {
          const pos = a1ToRowCol(cell.a1);
          if (!pos) {
            failed.push(cell.a1);
            return [];
          }
          return [
            {
              sheet: cell.sheet ?? 0,
              row: pos.row,
              col: pos.col,
              input: cell.input,
            },
          ];
        });
        if (edits.length === 0) return { staged: 0, failed };
        const proposal = await api.proposeChanges({
          agentId: "ai-assistant",
          note: summary,
          edits,
        });
        if (!proposal.ok) throw new Error("表格编辑器拒绝了这批修改");
        // 打开审阅面板，让用户逐条接受/拒绝
        await api.commands.execute("proposalsPanel", { open: true });
        return { staged: edits.length, failed };
      },
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (reloadOnceForChunkError(e.error ?? e.message)) e.preventDefault();
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (reloadOnceForChunkError(e.reason)) e.preventDefault();
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-danger">{error}</p>
        <button
          type="button"
          className="ac-btn px-3 py-1.5 text-xs"
          onClick={() => window.location.reload()}
        >
          重新加载页面
        </button>
      </div>
    );
  }

  if (!bytes) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-ink-faint">
        表格加载中…
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <XlsxEditor
        key={reloadToken}
        file={bytes}
        fileName={filename}
        readOnly={readOnly}
        className="min-h-0 flex-1"
        style={{ height: "100%" }}
        onReady={(api: XlsxAsyncEditorApi) => {
          instanceRef.current = api;
          dirtyRef.current = false;
          clearChunkReloadFlag();
        }}
        onDocumentChange={() => {
          dirtyRef.current = true;
          onDirtyRef.current();
        }}
        onChange={() => {
          dirtyRef.current = true;
          onDirtyRef.current();
        }}
        onSaveRequest={() => {
          onSaveRef.current();
          return false;
        }}
        onError={(e: Error) => setError(e.message || "表格编辑器加载失败")}
      />
    </div>
  );
}
