import { detectPreviewKind, extOf } from "@/lib/file-preview";

/**
 * 文件图标分类：在「能不能预览」之外再细分文本类文件，
 * 让代码、网页、数据/配置、Markdown、压缩包在列表里一眼可分。
 *
 * 判定口径与 `detectPreviewKind` 保持一致（mimeType 优先、扩展名兜底），
 * Office / 图片 / 音视频 / PDF 直接复用预览类别，只有 text / unsupported
 * 再按扩展名细分。
 */
export type FileIconKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "word"
  | "doc"
  | "excel"
  | "ppt"
  | "markdown"
  | "code"
  | "web"
  | "data"
  | "text"
  | "archive"
  | "other";

export const FILE_ICON_LABELS: Record<FileIconKind, string> = {
  image: "图片",
  pdf: "PDF",
  video: "视频",
  audio: "音频",
  word: "Word 文档",
  doc: "Word 文档（旧版）",
  excel: "Excel 表格",
  ppt: "PPT 幻灯片",
  markdown: "Markdown 文档",
  code: "代码",
  web: "网页 / 样式",
  data: "数据 / 配置",
  text: "文本",
  archive: "压缩包",
  other: "文件",
};

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx", "rst", "adoc"]);

const WEB_EXTS = new Set([
  "html", "htm", "xhtml", "css", "scss", "sass", "less", "vue", "svelte", "astro",
]);

const DATA_EXTS = new Set([
  // 数据 / 配置 / Notebook
  "csv", "tsv", "json", "jsonc", "json5", "xml", "yml", "yaml", "toml", "ini",
  "conf", "config", "properties", "env", "lock", "sum", "map", "ipynb",
  "graphql", "gql", "proto",
]);

const CODE_EXTS = new Set([
  // JS / TS 生态
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs",
  // 系统 / 后端语言
  "py", "pyw", "pyi", "rb", "java", "kt", "kts", "scala", "groovy", "gradle",
  "clj", "cljs", "cljc", "edn", "cs", "fs", "fsx", "vb", "vbs", "go", "rs",
  "php", "swift", "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl",
  "hrl", "hs", "lhs", "elm", "ml", "mli", "nim", "zig", "d", "pas", "tcl",
  "awk", "sed", "sol", "move", "rkt", "scm", "lisp", "el", "vhd", "vhdl",
  "sv", "v", "ino",
  // C / C++ 家族
  "c", "h", "cpp", "hpp", "cc", "cxx", "hh", "hxx", "c++", "h++", "m", "mm",
  "cu", "cuh",
  // 汇编 / 数值
  "s", "asm", "f", "f90", "f95", "for",
  // 脚本 / 构建 / 基础设施
  "sql", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "psm1", "mk", "mak",
  "cmake", "bazel", "bzl", "tf", "tfvars", "hcl", "nix",
]);

const ARCHIVE_EXTS = new Set(["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst"]);

// 无扩展名的常见文件：按「更像代码还是配置」归类
const CODE_FILENAMES = new Set([
  "makefile", "gnumakefile", "dockerfile", "containerfile", "cmakelists.txt",
  "jenkinsfile", "vagrantfile", "gemfile", "rakefile", "procfile", "justfile",
  "brewfile",
]);

const DATA_FILENAMES = new Set([
  ".gitignore", ".gitattributes", ".gitmodules", ".dockerignore", ".editorconfig",
  ".npmrc", ".nvmrc", ".yarnrc", ".babelrc", ".prettierrc", ".prettierignore",
  ".eslintrc", ".eslintignore", ".stylelintrc", ".env", ".env.local", ".htaccess",
]);

const TEXT_FILENAMES = new Set([
  "license", "licence", "notice", "readme", "changelog", "authors", "contributors",
]);

function baseNameOf(filename: string): string {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  return filename.slice(slash + 1).toLowerCase();
}

/** 文件名 → 图标分类；任何能识别预览方式的文件都有对应图标 */
export function fileIconKind(
  filename: string,
  mimeType?: string | null,
): FileIconKind {
  const kind = detectPreviewKind(filename, mimeType);
  switch (kind) {
    case "image":
    case "pdf":
    case "video":
    case "audio":
    case "word":
    case "doc":
    case "excel":
    case "ppt":
      return kind;
    case "text": {
      const name = baseNameOf(filename);
      if (CODE_FILENAMES.has(name)) return "code";
      if (DATA_FILENAMES.has(name)) return "data";
      if (TEXT_FILENAMES.has(name)) return "text";
      const ext = extOf(filename);
      if (MARKDOWN_EXTS.has(ext)) return "markdown";
      if (WEB_EXTS.has(ext)) return "web";
      if (DATA_EXTS.has(ext)) return "data";
      if (CODE_EXTS.has(ext)) return "code";
      return "text";
    }
    default:
      // 不支持预览的文件里，资源库仍能识别压缩包
      return ARCHIVE_EXTS.has(extOf(filename)) ? "archive" : "other";
  }
}

export function fileIconLabel(
  filename: string,
  mimeType?: string | null,
): string {
  return FILE_ICON_LABELS[fileIconKind(filename, mimeType)];
}
