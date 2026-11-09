import JSZip from "jszip";
import { AppError } from "@/lib/errors";
import {
  normalizeSkillDraft,
  normalizeSkillPath,
  SKILL_DESCRIPTION_MAX,
  SKILL_FILE_MAX_CHARS,
  SKILL_MAX_FILES,
  type SkillDraft,
  type SkillOrigin,
} from "@/lib/skill";
import type { SkillFile } from "@/db/schema";

/**
 * 技能导入：把外部技能包解析成平台内部结构。
 *
 * 支持三种来源，覆盖目前常见的「技能」形态：
 * 1. **Claude Agent Skills**：`SKILL.md`（YAML frontmatter + 正文）+ `references/`、`scripts/` 等；
 *    可上传单个 `.md`，也可上传包含 SKILL.md 的 `.zip`（允许外面套一层目录）。
 * 2. **Markdown 提示词包**（OpenAI / DeepSeek 常见做法）：没有 frontmatter 也行，
 *    取第一个 `# 标题` 当名称、首段当描述、全文当正文。
 * 3. **JSON 提示词包**：`{ "name", "description", "instructions" }`；
 *    兼容 `prompt` / `body` / `content` / `system_prompt` 等常见别名。
 *
 * 参考文件只保存文本；二进制资源（图片、字体等）会被跳过，`scripts/` 里的脚本
 * 原样保存但**永不执行** —— 平台没有沙箱，执行外部脚本不可接受。
 */

export const SKILL_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
/** zip 解压后的总大小上限：防 zip bomb（2MB 压缩包可以解出几个 G） */
export const SKILL_ZIP_MAX_UNCOMPRESSED_BYTES = 1_500_000;
const SKILL_ENTRY_MAX_BYTES = 300_000;

export type ParsedSkill = SkillDraft & { origin: SkillOrigin };

export async function parseSkillUpload(
  filename: string,
  data: Uint8Array,
): Promise<ParsedSkill> {
  if (data.byteLength === 0) throw new AppError("文件是空的");
  if (data.byteLength > SKILL_UPLOAD_MAX_BYTES)
    throw new AppError(`技能文件最大 ${formatBytes(SKILL_UPLOAD_MAX_BYTES)}`);

  const lower = filename.toLowerCase();
  if (lower.endsWith(".zip") || isZip(data)) return parseZip(filename, data);
  if (lower.endsWith(".json")) {
    const text = decodeUtf8(data, filename);
    return parseJsonSkill(text, filename);
  }
  const text = decodeUtf8(data, filename);
  // 扩展名没写对但内容是 JSON 也认
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return parseJsonSkill(text, filename);
  return parseMarkdownSkill(text, filename);
}

// --------------------------------------------------------------- Markdown

function parseMarkdownSkill(text: string, filename: string): ParsedSkill {
  const { meta, body } = splitFrontmatter(text.replace(/\r\n?/g, "\n"));
  const instructions = body.trim();
  if (!instructions) throw new AppError("技能正文为空");

  const fallbackName = basename(filename).replace(/\.[^.]+$/, "");
  const name = meta.name || firstHeading(instructions) || fallbackName;
  const description =
    meta.description || firstParagraph(instructions) || `导入的技能：${name}`;

  return {
    ...normalizeSkillDraft({
      name,
      description: clip(description, SKILL_DESCRIPTION_MAX),
      instructions,
      files: [],
    }),
    origin: Object.keys(meta).length > 0 ? "claude" : "markdown",
  };
}

/**
 * 极简 frontmatter：只认 `key: value` 与 `key: >` / `key: |` 两种常见写法。
 * Claude SKILL.md 的 frontmatter 只有 name / description（外加可选的 license、metadata），
 * 不值得为它引入整个 YAML 解析器；认不出的键直接忽略。
 */
export function splitFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return { meta: {}, body: text };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { meta: {}, body: text };

  const meta: Record<string, string> = {};
  const header = lines.slice(1, end);
  for (let i = 0; i < header.length; i++) {
    const m = header[i].match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    let value = m[2].trim();

    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < header.length && /^\s+/.test(header[i + 1])) {
        block.push(header[++i].trim());
      }
      value = value.startsWith(">") ? block.join(" ") : block.join("\n");
    } else {
      value = unquote(value);
    }
    meta[key] = value;
  }
  return { meta, body: lines.slice(end + 1).join("\n") };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'"))
      return value.slice(1, -1);
  }
  return value;
}

function firstHeading(markdown: string): string | null {
  const m = markdown.match(/^#\s+(.+)$/m);
  return m ? m[1].replace(/[*_`]/g, "").trim() : null;
}

function firstParagraph(markdown: string): string | null {
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("```") || line.startsWith("---"))
      continue;
    return (
      line.replace(/^(?:[>*\-]+\s*|\d+[.)]\s*)/, "").replace(/[*_`]/g, "").trim() ||
      null
    );
  }
  return null;
}

// --------------------------------------------------------------- JSON

function parseJsonSkill(text: string, filename: string): ParsedSkill {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new AppError("JSON 格式无效");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new AppError("JSON 技能包必须是一个对象");

  const obj = value as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

  const instructions =
    str(obj.instructions) ??
    str(obj.prompt) ??
    str(obj.system_prompt) ??
    str(obj.body) ??
    str(obj.content);
  if (!instructions) throw new AppError("JSON 里没有找到技能正文（instructions / prompt）");

  const fallbackName = basename(filename).replace(/\.[^.]+$/, "");
  const name = str(obj.name) ?? str(obj.skill) ?? fallbackName;
  const description =
    str(obj.description) ?? str(obj.summary) ?? firstParagraph(instructions) ?? `导入的技能：${name}`;

  return {
    ...normalizeSkillDraft({
      name,
      description: clip(description, SKILL_DESCRIPTION_MAX),
      instructions,
      files: normalizeJsonFiles(obj.files),
    }),
    origin: "json",
  };
}

function normalizeJsonFiles(raw: unknown): SkillFile[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return undefined;
  const files: SkillFile[] = [];
  for (const item of raw) {
    if (typeof item === "string") continue;
    const obj = (item ?? {}) as { path?: unknown; content?: unknown };
    if (typeof obj.path !== "string" || typeof obj.content !== "string") continue;
    files.push({ path: obj.path, content: obj.content });
  }
  return files;
}

// --------------------------------------------------------------- ZIP

async function parseZip(
  filename: string,
  data: Uint8Array,
): Promise<ParsedSkill> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    throw new AppError("无法读取 zip 包（文件可能已损坏）");
  }

  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length === 0) throw new AppError("zip 里没有文件");

  // 先按未压缩大小拦截，避免解压阶段被 zip bomb 撑爆内存
  let declared = 0;
  for (const entry of entries) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
      ?.uncompressedSize;
    if (typeof size === "number") declared += size;
  }
  if (declared > SKILL_ZIP_MAX_UNCOMPRESSED_BYTES)
    throw new AppError("zip 解压后过大，请精简参考文件后重试");

  const skillEntry = entries.find((f) => /(^|\/)skill\.md$/i.test(f.name));
  if (!skillEntry) throw new AppError("zip 里没有找到 SKILL.md");

  const skillRaw = await readTextEntry(skillEntry);
  const dir = skillEntry.name.includes("/")
    ? skillEntry.name.slice(0, skillEntry.name.lastIndexOf("/") + 1)
    : "";
  const folderName = dir ? dir.split("/").filter(Boolean).pop() : "";
  const fallback = folderName || basename(filename).replace(/\.zip$/i, "");
  const full = await parseMarkdownSkill(skillRaw, `${fallback}.md`);

  const candidates = entries
    .filter((f) => f !== skillEntry)
    .filter((f) => (dir ? f.name.startsWith(dir) : true))
    .map((f) => ({ entry: f, path: dir ? f.name.slice(dir.length) : f.name }))
    .filter(({ path }) => isCandidateReference(path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const files: SkillFile[] = [];
  let readBytes = 0;
  for (const { entry, path } of candidates) {
    const bytes = await entry.async("uint8array");
    // 有些 zip 条目没有声明 uncompressedSize：按实际读到的量再兜一次底
    readBytes += bytes.byteLength;
    if (readBytes > SKILL_ZIP_MAX_UNCOMPRESSED_BYTES)
      throw new AppError("zip 解压后过大，请精简参考文件后重试");
    // 图片、字体等二进制资源：有 NUL 字节即跳过；技能正文用不到它们
    if (bytes.byteLength > SKILL_ENTRY_MAX_BYTES) continue;
    if (bytes.includes(0)) continue;
    const content = decodeUtf8(bytes, path);
    if (content.length > SKILL_FILE_MAX_CHARS)
      throw new AppError(`参考文件「${path}」超过 ${SKILL_FILE_MAX_CHARS} 字`);
    if (files.length >= SKILL_MAX_FILES)
      throw new AppError(`参考文件最多 ${SKILL_MAX_FILES} 个`);
    files.push({ path: normalizeSkillPath(path), content });
  }

  return {
    ...normalizeSkillDraft({ ...full, files: [...files, ...full.files] }),
    origin: "claude",
  };
}

function isCandidateReference(path: string): boolean {
  if (!path || path.endsWith("/")) return false;
  if (path.startsWith("__MACOSX/") || path.split("/").some((s) => s.startsWith("._")))
    return false;
  if (/^skill\.md$/i.test(path)) return false;
  return true;
}

async function readTextEntry(entry: JSZip.JSZipObject): Promise<string> {
  const bytes = await entry.async("uint8array");
  if (bytes.byteLength > SKILL_ENTRY_MAX_BYTES)
    throw new AppError("SKILL.md 过大");
  return decodeUtf8(bytes, entry.name);
}

// --------------------------------------------------------------- helpers

function decodeUtf8(data: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    throw new AppError(`「${label}」不是 UTF-8 文本`);
  }
}

function basename(filename: string): string {
  return filename.replace(/\\/g, "/").split("/").pop() || filename;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))} MB` : `${Math.round(n / 1024)} KB`;
}
