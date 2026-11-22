"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import type { PptxFontFace } from "@betteroffice/pptx";
import type { PptxAsyncEditorApi } from "@betteroffice/pptx-react";

/**
 * PowerPoint 在线编辑：BetterOffice PPTX 引擎（Apache-2.0）。
 *
 * 在 PPTX/OOXML 上直接编辑，保存时只重新生成改动过的幻灯片，未改动的
 * slide part 保留原始字节；因此字体、主题、母版、图片等格式不会因为
 * 经过 HTML/JSON 转换而丢失（个别复杂动画/特效仍可能被近似处理）。
 */

const PptxEditor = dynamic(
  () => import("@betteroffice/pptx-react").then((m) => m.PptxEditor),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-ink-faint">
        正在加载演示文稿编辑器…
      </div>
    ),
  },
);

export type PptxEditorApi = {
  getBytes: () => Promise<Uint8Array | null>;
  markClean: () => void;
  isDirty: () => boolean;
};

// 字体只加载一次：中文字体较大，避免每次进编辑器都重新拉取
let fontsPromise: Promise<PptxFontFace[]> | null = null;

function loadEditorFonts(): Promise<PptxFontFace[]> {
  if (!fontsPromise) {
    fontsPromise = (async () => {
      const { BUNDLED_FONTS, loadBundledFontBytes } = await import("@betteroffice/fonts");
      const wanted = new Set([
        "Noto Sans SC", // 微软雅黑 / 黑体 / 等线
        "Noto Serif SC", // 宋体 / 仿宋 / 楷体
        "Carlito", // Calibri
        "Liberation Sans", // Arial
      ]);
      const faces = BUNDLED_FONTS.filter((face) => wanted.has(face.family));
      return Promise.all(
        faces.map(async (face) => ({
          family: face.family,
          bold: face.weight === 700,
          italic: face.style === "italic",
          bytes: new Uint8Array(await loadBundledFontBytes(face)),
        })),
      );
    })().catch((e) => {
      fontsPromise = null;
      throw e;
    });
  }
  return fontsPromise;
}

export function PptxEditorHost({
  bytes,
  reloadToken,
  readOnly,
  filename,
  apiRef,
  onDirty,
  onSave,
}: {
  bytes: ArrayBuffer | null;
  /** 远程新版本/恢复历史时递增，强制重建编辑器 */
  reloadToken: number;
  readOnly: boolean;
  filename: string;
  apiRef: { current: PptxEditorApi | null };
  onDirty: () => void;
  onSave: () => void;
}) {
  const [fonts, setFonts] = useState<PptxFontFace[] | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const instanceRef = useRef<PptxAsyncEditorApi | null>(null);
  const dirtyRef = useRef(false);
  const onDirtyRef = useRef(onDirty);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onDirtyRef.current = onDirty;
    onSaveRef.current = onSave;
  }, [onDirty, onSave]);

  useEffect(() => {
    let cancelled = false;
    void loadEditorFonts()
      .then((loaded) => {
        if (!cancelled) setFonts(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "字体加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [retry]);

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
    };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef]);

  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-danger">{error}</p>
        <button
          type="button"
          className="ac-btn px-3 py-1.5 text-xs"
          onClick={() => {
            setError("");
            setFonts(null);
            setRetry((t) => t + 1);
          }}
        >
          重试
        </button>
      </div>
    );
  }

  if (!bytes) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-sm text-ink-faint">
        演示文稿加载中…
      </div>
    );
  }

  if (!fonts) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-ink-faint">
        <span>正在加载演示文稿字体（首次约 20MB，之后走浏览器缓存）…</span>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PptxEditor
        key={reloadToken}
        file={bytes}
        fonts={fonts}
        readOnly={readOnly}
        fileName={filename}
        className="min-h-0 flex-1"
        style={{ height: "100%" }}
        onReady={(api: PptxAsyncEditorApi) => {
          instanceRef.current = api;
          dirtyRef.current = false;
        }}
        onDocumentChange={() => {
          dirtyRef.current = true;
          onDirtyRef.current();
        }}
        onSaveRequest={() => {
          onSaveRef.current();
          // 取消编辑器自带的下载/保存；实际的字节由父组件统一保存
          return false;
        }}
        onError={(e: Error) => setError(e.message || "演示文稿编辑失败")}
      />
    </div>
  );
}
