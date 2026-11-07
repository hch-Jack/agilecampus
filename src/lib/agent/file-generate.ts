import { AppError } from "@/lib/errors";

/**
 * 助手「生成文件」。
 *
 * 模型给文件名 + 正文，这里按扩展名编码成真实文件：
 * - 文本类（txt/md/csv/json/html/xml/svg/代码…）：UTF-8 原样写入；
 * - xlsx：正文按 CSV 解析后转成真正的 Excel 工作簿（沿用已有的 `xlsx` 依赖）；
 * - docx：正文按行分段，用最小的 OOXML 包生成（自写 zip，不引新依赖）。
 *
 * PDF/PPT 不在支持范围内：中文字体嵌入与版式不是几十行能可靠做对的，
 * 想要 PDF 就让模型生成 HTML，用户再打印成 PDF。
 */

/** 生成正文的长度上限（约 20 万字符，足够一份长文档或几万行 CSV） */
export const GENERATE_MAX_CHARS = 200_000;

export const GENERATE_SUPPORTED_LABEL =
  "txt、md、csv、json、html、xml、svg、yml/toml/ini、常见代码文件，以及 xlsx、docx";

const TEXT_MIME: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  tsv: "text/tab-separated-values; charset=utf-8",
  json: "application/json; charset=utf-8",
  jsonl: "application/x-ndjson; charset=utf-8",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  svg: "image/svg+xml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  toml: "application/toml; charset=utf-8",
  ini: "text/plain; charset=utf-8",
  css: "text/css; charset=utf-8",
  scss: "text/x-scss; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  cjs: "text/javascript; charset=utf-8",
  jsx: "text/javascript; charset=utf-8",
  ts: "text/typescript; charset=utf-8",
  tsx: "text/typescript; charset=utf-8",
  py: "text/x-python; charset=utf-8",
  java: "text/x-java; charset=utf-8",
  c: "text/x-c; charset=utf-8",
  h: "text/x-c; charset=utf-8",
  cpp: "text/x-c++; charset=utf-8",
  cs: "text/x-csharp; charset=utf-8",
  go: "text/x-go; charset=utf-8",
  rs: "text/x-rust; charset=utf-8",
  php: "text/x-php; charset=utf-8",
  rb: "text/x-ruby; charset=utf-8",
  sh: "text/x-sh; charset=utf-8",
  bash: "text/x-sh; charset=utf-8",
  sql: "application/sql; charset=utf-8",
  tex: "text/x-tex; charset=utf-8",
};

export function fileExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0 || idx === filename.length - 1) return "";
  return filename.slice(idx + 1).toLowerCase();
}

export async function generateFile(input: {
  filename: string;
  content: string;
  sheetName?: string;
}): Promise<{ filename: string; mimeType: string; data: Buffer }> {
  const filename = input.filename.trim().slice(0, 200);
  if (!filename) throw new AppError("请给出文件名");
  if (!input.content) throw new AppError("文件内容不能为空");
  if (input.content.length > GENERATE_MAX_CHARS)
    throw new AppError(`生成内容最多 ${GENERATE_MAX_CHARS} 字符，请拆成多个文件`);

  const ext = fileExtension(filename);
  if (!ext) throw new AppError("文件名要带扩展名，例如 report.md / 数据.xlsx");
  if (ext === "xlsx") {
    return { filename, mimeType: XLSX_MIME, data: await xlsxFromCsv(input.content, input.sheetName) };
  }
  if (ext === "docx") {
    return { filename, mimeType: DOCX_MIME, data: docxFromText(input.content) };
  }
  const mimeType = TEXT_MIME[ext];
  if (!mimeType) {
    throw new AppError(`暂不支持生成 .${ext} 文件；支持 ${GENERATE_SUPPORTED_LABEL}`);
  }
  return { filename, mimeType, data: Buffer.from(input.content, "utf8") };
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function xlsxFromCsv(content: string, sheetName?: string): Promise<Buffer> {
  const XLSX = await import("xlsx");
  let workbook;
  try {
    // type:string 让 SheetJS 自己识别分隔符（逗号/制表符）与引号
    workbook = XLSX.read(content, { type: "string" });
  } catch {
    throw new AppError("Excel 内容需为 CSV 文本（第一行作表头）");
  }
  if (sheetName?.trim()) {
    const old = workbook.SheetNames[0];
    const name = sheetName.trim().slice(0, 31);
    workbook.SheetNames[0] = name;
    workbook.Sheets[name] = workbook.Sheets[old];
    if (name !== old) delete workbook.Sheets[old];
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

// —— 最小 DOCX 生成：每行一段，不引新依赖 ——

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function docxFromText(text: string): Buffer {
  const paragraphs = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        ? `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
        : "<w:p/>",
    )
    .join("");

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";

  return zipStore([
    { name: "[Content_Types].xml", data: Buffer.from(contentTypes, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(rels, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 只存不压（method 0）的 zip：Word/mammoth 都能读，省掉压缩库依赖 */
function zipStore(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  // DOS 时间戳：1980-01-01 00:00（最低合法值），固定值让产物可复现
  const dosTime = 0;
  const dosDate = (1 << 5) | 1;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + entry.data.length;
  }

  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}
