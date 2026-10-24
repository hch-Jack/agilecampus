/**
 * 附件在线预览的纯逻辑（无 React、无 DOM 依赖，可单测）：
 * 按扩展名 + mimeType 判定预览方式，给 blob URL 补正 Content-Type，
 * 文本按 UTF-8 → GBK 探测解码。
 *
 * 安全口径：服务端下载路由恒为 attachment 响应（防 HTML/SVG 内联 XSS），
 * 预览全在前端做 —— 图片走 <img>、PDF 走 blob URL 的 <iframe>、文本只按
 * 纯文本渲染（React 转义），不新增任何 inline 服务端响应。
 */

export type PreviewKind =
  | "image"
  | "pdf"
  | "video"
  | "audio"
  | "text"
  | "word"
  | "doc"
  | "excel"
  | "ppt"
  | "unsupported";

const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const PDF_EXTS = new Set(["pdf"]);
const VIDEO_EXTS = new Set(["mp4", "webm", "ogv", "mov", "m4v", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac", "wma"]);
// 按纯文本预览的扩展名（HTML/XML 也按源码文本展示，绝不内联渲染）。
// 覆盖常见源码、脚本、配置与构建文件；`.m`（Obj-C/MATLAB）、`.v`（Verilog）、
// `.s`（汇编）、`.f`（Fortran）这类同名多义扩展也统一按文本看。
const TEXT_EXTS = new Set([
  // 文档 / 数据 / 配置
  "txt", "md", "markdown", "mdx", "rst", "adoc", "csv", "tsv", "json", "jsonc", "json5",
  "xml", "yml", "yaml", "toml", "ini", "conf", "config", "log", "properties", "env",
  "lock", "sum", "map",
  // JS / TS 生态
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "vue", "svelte", "astro",
  // 系统 / 后端语言
  "py", "pyw", "pyi", "rb", "java", "kt", "kts", "scala", "groovy", "gradle", "clj",
  "cljs", "cljc", "edn", "cs", "fs", "fsx", "vb", "vbs", "go", "rs", "php", "swift",
  "dart", "lua", "pl", "pm", "r", "jl", "ex", "exs", "erl", "hrl", "hs", "lhs", "elm",
  "ml", "mli", "nim", "zig", "d", "pas", "tcl", "awk", "sed", "sol", "move", "rkt",
  "scm", "lisp", "el", "vb", "vhd", "vhdl", "sv", "v", "ino",
  // C / C++ 家族
  "c", "h", "cpp", "hpp", "cc", "cxx", "hh", "hxx", "c++", "h++", "m", "mm", "cu", "cuh",
  // 汇编 / 数值
  "s", "asm", "f", "f90", "f95", "for",
  // 脚本 / 构建 / 基础设施
  "sql", "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "psm1", "mk", "mak", "cmake",
  "bazel", "bzl", "tf", "tfvars", "hcl", "nix", "dockerfile", "makefile", "proto",
  "graphql", "gql", "tex", "bib",
  // Web
  "html", "htm", "xhtml", "css", "scss", "sass", "less",
  // Notebook（JSON 文本）
  "ipynb",
]);
// 无扩展名但确定是文本的常见文件名（取 basename 小写比较）
const TEXT_FILENAMES = new Set([
  "makefile", "gnumakefile", "dockerfile", "containerfile", "cmakelists.txt", "jenkinsfile",
  "vagrantfile", "gemfile", "rakefile", "procfile", "justfile", "brewfile",
  "license", "licence", "notice", "readme", "changelog", "authors", "contributors",
  ".gitignore", ".gitattributes", ".gitmodules", ".dockerignore", ".editorconfig",
  ".npmrc", ".nvmrc", ".yarnrc", ".babelrc", ".prettierrc", ".prettierignore",
  ".eslintrc", ".eslintignore", ".stylelintrc", ".env", ".env.local", ".htaccess",
]);
// Office 在线预览：docx 走 docx-preview（保真渲染，mammoth 兜底），
// 旧版二进制 .doc 走 CFB 解析出正文纯文本；xlsx/xls 等走 SheetJS 转表格；
// pptx 走 pptx-preview 渲染幻灯片。旧版 .ppt 无可靠的纯 JS 渲染方案（提示下载）。
const WORD_EXTS = new Set(["docx", "docm", "dotx", "dotm"]);
// 旧版 Word 97-2003 二进制格式：只能抽取正文，排版与图片无法还原
const DOC_EXTS = new Set(["doc", "dot"]);
const EXCEL_EXTS = new Set(["xlsx", "xlsm", "xlsb", "xls", "xltx", "xltm", "xlt", "ods"]);
const PPT_EXTS = new Set(["pptx", "pptm", "ppsx", "potx"]);

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}

function baseNameOf(filename: string): string {
  const slash = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
  return filename.slice(slash + 1).toLowerCase();
}

function isTextName(filename: string): boolean {
  return TEXT_EXTS.has(extOf(filename)) || TEXT_FILENAMES.has(baseNameOf(filename));
}

/**
 * 预览方式判定：mimeType 优先（上传时浏览器给的是可信的），扩展名兜底
 * （早期数据/客户端没带 mime 时 filename 仍在）。两者都不认识则不支持预览。
 */
export function detectPreviewKind(
  filename: string,
  mimeType?: string | null,
): PreviewKind {
  const ext = extOf(filename);
  const mime = (mimeType ?? "").toLowerCase();

  if (mime.startsWith("image/") || IMAGE_EXTS.has(ext)) return "image";
  if (mime === "application/pdf" || PDF_EXTS.has(ext)) return "pdf";
  if (mime.startsWith("video/") || VIDEO_EXTS.has(ext)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXTS.has(ext)) return "audio";
  if (
    mime.startsWith("application/vnd.openxmlformats-officedocument.wordprocessingml") ||
    WORD_EXTS.has(ext)
  ) {
    return "word";
  }
  // 旧版二进制 Word：只能抽正文，故单列一种预览方式
  if (mime === "application/msword" || DOC_EXTS.has(ext)) return "doc";
  if (
    mime.startsWith("application/vnd.openxmlformats-officedocument.spreadsheetml") ||
    mime.startsWith("application/vnd.ms-excel") ||
    mime === "application/vnd.oasis.opendocument.spreadsheet" ||
    EXCEL_EXTS.has(ext)
  ) {
    return "excel";
  }
  if (
    mime.startsWith("application/vnd.openxmlformats-officedocument.presentationml") ||
    PPT_EXTS.has(ext)
  ) {
    return "ppt";
  }
  // text/html 按文本展示源码；application/json、+xml、+json 等 API 常见类型也归文本。
  // 代码文件在部分系统会带 application/x-... 或 octet-stream，靠扩展名/文件名兜底。
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/xml" ||
    mime === "application/x-httpd-php" ||
    mime === "application/x-sh" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    isTextName(filename)
  ) {
    return "text";
  }
  return "unsupported";
}

// blob URL 渲染（iframe/video/audio）时需要正确的 Content-Type，浏览器才肯
// 内置播放/渲染；库里存的 mime 缺失或不准时按扩展名补正。
const VIDEO_MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  aac: "audio/aac",
  wma: "audio/x-ms-wma",
};

/**
 * 给 blob 补正渲染用 Content-Type：mime 本身可用则原样返回，否则按扩展名映射。
 * image/text 不需要（<img> 嗅探内容、文本前端解码），其余 unsupported 返回 null。
 */
export function renderMimeFor(
  filename: string,
  mimeType?: string | null,
): string | null {
  const mime = (mimeType ?? "").toLowerCase();
  switch (detectPreviewKind(filename, mimeType)) {
    case "pdf":
      return "application/pdf";
    case "video":
      return mime.startsWith("video/") ? mime : (VIDEO_MIME_BY_EXT[extOf(filename)] ?? null);
    case "audio":
      return mime.startsWith("audio/") ? mime : (AUDIO_MIME_BY_EXT[extOf(filename)] ?? null);
    default:
      return null;
  }
}

// 文本预览渲染上限：10MB 文本全量塞进 DOM 会卡死页面，超出截断提示下载
export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;

/**
 * 字节按 UTF-8 → GBK 探测解码（Windows 用户常见 GBK 记事本文件），
 * 两者都解不动（二进制/其他编码）则按 UTF-8 宽松解码（替换非法字符）。
 * 被截断的末字节可能恰好切断多字节字符，前两级 fatal 失败会自然落到宽松解码。
 */
export function decodeTextWithFallback(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes.length === 0) return "";
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // 继续尝试 GBK
  }
  try {
    return new TextDecoder("gbk", { fatal: true }).decode(bytes);
  } catch {
    // 落到宽松解码
  }
  return new TextDecoder("utf-8").decode(bytes);
}
