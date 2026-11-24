// 把 SuperDoc 的两份样式合并成 public/superdoc.css，交给浏览器按原样加载。
//
// 原因：SuperDoc 用到 CSS Custom Highlight API 的 `::highlight(...)`，
// Lightning CSS（Next/Turbopack 的 CSS 处理器）不认识它，每次构建都会刷 8 条
// “not recognized as a valid pseudo-element” 警告。放进 public/ 后 Next 不再
// 处理这份 CSS，警告消失，也省掉一次 142KB 的解析/压缩。
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const superdocDir = path.join(root, "node_modules", "superdoc");
const engineCss = path.join(
  root,
  "node_modules",
  "@superdoc",
  "docx-engine",
  "dist",
  "style.css",
);
const mainCss = path.join(superdocDir, "dist", "style.css");

const version = JSON.parse(
  fs.readFileSync(path.join(superdocDir, "package.json"), "utf8"),
).version;

const engine = fs.readFileSync(engineCss, "utf8");
const main = fs
  .readFileSync(mainCss, "utf8")
  // 原文件第一行 @import 引擎样式，这里改成直接拼接
  .replace(/^@import[^;]+;\s*/, "");

const out = [
  `/* Generated from superdoc v${version} (AGPL-3.0) — do not edit by hand. */`,
  `/* Run: npm run build:superdoc-css (also runs before npm run dev/build). */`,
  engine,
  main,
  "",
].join("\n");

fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(path.join(root, "public", "superdoc.css"), out);
console.log(`[superdoc-css] wrote public/superdoc.css (superdoc v${version})`);
