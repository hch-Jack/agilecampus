"use client";

import { useMemo, useState } from "react";
import { Markdown } from "@/components/markdown";

type Props = {
  value: string;
  onChange: (value: string) => void;
  readOnly: boolean;
  markdown: boolean;
  onSave: () => void;
};

/** 文本/代码/Markdown 编辑器：textarea + 可选 Markdown 预览。 */
export function TextEditor({ value, onChange, readOnly, markdown, onSave }: Props) {
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const lines = useMemo(() => value.split("\n").length, [value]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {markdown && (
        <div className="flex items-center gap-1 border-b border-line px-3 py-1.5">
          {(["edit", "preview"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`ac-btn-ghost px-2 py-1 text-xs ${
                tab === t ? "bg-surface-2 text-ink" : "text-ink-soft"
              }`}
            >
              {t === "edit" ? "编辑" : "预览"}
            </button>
          ))}
        </div>
      )}

      {markdown && tab === "preview" ? (
        <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
          <Markdown>{value}</Markdown>
        </div>
      ) : (
        <textarea
          className="min-h-0 w-full flex-1 resize-none bg-transparent px-4 py-3 font-mono text-[13px] leading-6 text-ink outline-none"
          value={value}
          readOnly={readOnly}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
              e.preventDefault();
              onSave();
              return;
            }
            if (e.key === "Tab" && !readOnly) {
              e.preventDefault();
              const target = e.currentTarget;
              const start = target.selectionStart;
              const end = target.selectionEnd;
              const next = `${value.slice(0, start)}  ${value.slice(end)}`;
              onChange(next);
              requestAnimationFrame(() => {
                target.selectionStart = target.selectionEnd = start + 2;
              });
            }
          }}
        />
      )}

      <div className="border-t border-line px-3 py-1 text-[11px] text-ink-faint">
        {lines} 行 · {value.length.toLocaleString()} 字符
        {readOnly && " · 只读"}
      </div>
    </div>
  );
}
