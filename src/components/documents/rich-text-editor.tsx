"use client";

import { useEffect, useRef } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";

type Props = {
  /** Tiptap JSON 或 mammoth 导入的 HTML */
  content: unknown;
  /** 外部加载（远程更新/历史版本）时递增，强制重置编辑器内容 */
  reloadToken: number;
  readOnly: boolean;
  onChange: (doc: unknown) => void;
  onSave: () => void;
};

/** Word 富文本编辑：Tiptap + 基础表格/图片。 */
export function RichTextEditor({ content, reloadToken, readOnly, onChange, onSave }: Props) {
  const imageInputRef = useRef<HTMLInputElement>(null);

  const editor = useEditor({
    immediatelyRender: false,
    editable: !readOnly,
    extensions: [
      StarterKit.configure({
        link: { openOnClick: false },
      }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: true }),
      Placeholder.configure({ placeholder: "开始输入正文…" }),
    ],
    content: content as never,
    editorProps: {
      attributes: {
        class:
          "prose-ac min-h-[50vh] px-8 py-6 outline-none text-ink [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:text-lg [&_h3]:font-semibold [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-ink-soft [&_pre]:rounded [&_pre]:bg-surface-2 [&_pre]:p-3 [&_pre]:font-mono [&_code]:font-mono [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-line [&_td]:p-2 [&_th]:border [&_th]:border-line [&_th]:bg-surface-2 [&_th]:p-2 [&_img]:max-w-full",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.getJSON()),
  });

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!readOnly);
  }, [editor, readOnly]);

  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(content as never, { emitUpdate: false });
  }, [editor, reloadToken]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
      }
    };
    const dom = editor.view.dom;
    dom.addEventListener("keydown", onKeyDown);
    return () => dom.removeEventListener("keydown", onKeyDown);
  }, [editor, onSave]);

  if (!editor) {
    return <div className="flex-1 p-6 text-sm text-ink-faint">编辑器加载中…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        editor={editor}
        readOnly={readOnly}
        onPickImage={() => imageInputRef.current?.click()}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/bmp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          if (file.size > 5 * 1024 * 1024) {
            window.alert("单张图片不能超过 5MB");
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const src = typeof reader.result === "string" ? reader.result : "";
            if (src) editor.chain().focus().setImage({ src }).run();
          };
          reader.readAsDataURL(file);
        }}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <EditorContent editor={editor} />
      </div>
      <div className="border-t border-line px-3 py-1 text-[11px] text-ink-faint">
        {readOnly ? "只读" : "支持标题、粗斜体、列表、引用、表格、图片"} · 复杂 Word 排版可能丢失
      </div>
    </div>
  );
}

function Toolbar({
  editor,
  readOnly,
  onPickImage,
}: {
  editor: Editor;
  readOnly: boolean;
  onPickImage: () => void;
}) {
  if (readOnly) return null;
  const btn = "ac-btn-ghost px-2 py-1 text-xs";
  const active = "bg-surface-2 text-ink";

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-line px-2 py-1.5">
      <button
        type="button"
        className={`${btn} ${editor.isActive("bold") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleBold().run()}
      >
        粗体
      </button>
      <button
        type="button"
        className={`${btn} ${editor.isActive("italic") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleItalic().run()}
      >
        斜体
      </button>
      <button
        type="button"
        className={`${btn} ${editor.isActive("underline") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleUnderline().run()}
      >
        下划线
      </button>
      <button
        type="button"
        className={`${btn} ${editor.isActive("strike") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleStrike().run()}
      >
        删除线
      </button>
      <span className="mx-1 h-4 w-px bg-line" />
      {[1, 2, 3].map((level) => (
        <button
          key={level}
          type="button"
          className={`${btn} ${editor.isActive("heading", { level }) ? active : ""}`}
          onClick={() =>
            editor.chain().focus().toggleHeading({ level: level as 1 | 2 | 3 }).run()
          }
        >
          H{level}
        </button>
      ))}
      <button
        type="button"
        className={`${btn} ${editor.isActive("bulletList") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
      >
        列表
      </button>
      <button
        type="button"
        className={`${btn} ${editor.isActive("orderedList") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
      >
        编号
      </button>
      <button
        type="button"
        className={`${btn} ${editor.isActive("blockquote") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
      >
        引用
      </button>
      <button
        type="button"
        className={`${btn} ${editor.isActive("codeBlock") ? active : ""}`}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
      >
        代码
      </button>
      <span className="mx-1 h-4 w-px bg-line" />
      <button
        type="button"
        className={btn}
        onClick={() =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
        }
      >
        表格
      </button>
      <button type="button" className={btn} onClick={onPickImage}>
        图片
      </button>
      <span className="mx-1 h-4 w-px bg-line" />
      <button
        type="button"
        className={btn}
        disabled={!editor.can().undo()}
        onClick={() => editor.chain().focus().undo().run()}
      >
        撤销
      </button>
      <button
        type="button"
        className={btn}
        disabled={!editor.can().redo()}
        onClick={() => editor.chain().focus().redo().run()}
      >
        重做
      </button>
    </div>
  );
}
