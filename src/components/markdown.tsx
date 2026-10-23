"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

/**
 * 助手正文的 Markdown 渲染。
 *
 * 模型作答习惯带 Markdown（粗体、列表、代码块、表格），此前面板按纯文本原样贴出来，
 * `**…**`、`- ` 全成了字面量。这里交给 react-markdown：默认**不渲染原始 HTML**（外部文本
 * 不是指令，也不该是标签），链接一律新窗口打开，样式只取项目已有的中性色 token。
 *
 * remark-breaks 把单个换行留成 `<br>`：模型偶尔整段平铺靠换行分句，不能让它们粘成一行。
 *
 * 面板只有 570px 宽，标题压到正文同级字号，表格与代码块横向滚动，不撑破气泡。
 */

const components: Components = {
  p: ({ children }) => (
    <p className="my-1 leading-relaxed first:mt-0 last:mb-0">{children}</p>
  ),
  h1: ({ children }) => (
    <h1 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-2 mb-1 text-sm font-medium first:mt-0">{children}</h4>
  ),
  ul: ({ children, className }) => {
    // GFM 任务清单自带 contains-task-list：勾选框已在，别再叠一层圆点
    const taskList = className?.includes("contains-task-list");
    return (
      <ul
        className={`my-1 space-y-0.5 pl-4 marker:text-ink-faint first:mt-0 last:mb-0 ${
          taskList ? "list-none pl-1" : "list-disc"
        }`}
      >
        {children}
      </ul>
    );
  },
  ol: ({ children }) => (
    <ol className="my-1 list-decimal space-y-0.5 pl-4 marker:text-ink-faint first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5 leading-relaxed">{children}</li>,
  input: ({ checked }) => (
    <input
      type="checkbox"
      checked={checked ?? false}
      readOnly
      disabled
      className="mr-1.5 align-middle accent-primary"
    />
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="break-words text-primary underline underline-offset-2 hover:text-primary-hover"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-ink-faint line-through">{children}</del>,
  code: ({ children, className }) => (
    <code
      className={`rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em] ${className ?? ""}`}
    >
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-1.5 overflow-x-auto rounded-md bg-sunken p-2 text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[inherit]">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-line-strong pl-2 text-ink-soft">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-2 border-line" />,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th
      style={style}
      className="border border-line bg-sunken px-2 py-1 text-left font-medium whitespace-nowrap"
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border border-line px-2 py-1 align-top">
      {children}
    </td>
  ),
  // 不在面板里加载远端图片：给出可点开的链接，避免自动请求外部地址
  img: ({ src, alt }) =>
    typeof src === "string" ? (
      <a
        href={src}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2"
      >
        {alt ? `[图片：${alt}]` : "[图片]"}
      </a>
    ) : null,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="break-words">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
