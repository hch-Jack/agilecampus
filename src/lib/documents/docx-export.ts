import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from "docx";
import { AppError } from "@/lib/errors";
import type { TiptapNode } from "./tiptap";

/**
 * Tiptap JSON → .docx（服务端）。
 *
 * 只映射我们承诺支持的子集：段落/标题 1-6、粗斜下删/行内代码、列表（最多 6 级）、
 * 引用、代码块、分割线、链接、表格（基础合并）、内嵌图片。
 * 公式、脚注、批注、修订、页眉页脚、分节分栏、图表/SmartArt、浮动图片等
 * 不在能力范围内（前端会常驻提示）。
 */

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
];

type Inline = TextRun | ExternalHyperlink | ImageRun;
type Numbering = { reference: string; levels: { level: number; format: typeof LevelFormat.DECIMAL; text: string; alignment: typeof AlignmentType.LEFT }[] };

let orderedCounter = 0;

export async function exportTiptapToDocx(doc: TiptapNode): Promise<Buffer> {
  const numbering: Numbering[] = [];
  const blocks = convertBlocks(doc.content ?? [], numbering, 0);
  const document = new Document({
    numbering: { config: numbering },
    sections: [{ properties: {}, children: blocks }],
  });
  return Packer.toBuffer(document);
}

function convertBlocks(nodes: TiptapNode[], numbering: Numbering[], listLevel: number): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
        out.push(
          new Paragraph({
            alignment: AlignmentType.LEFT,
            children: inlineChildren(node.content ?? []),
          }),
        );
        break;
      case "heading": {
        const level = typeof node.attrs?.level === "number" ? node.attrs.level : 1;
        out.push(
          new Paragraph({
            heading: HEADINGS[Math.min(Math.max(level - 1, 0), 5)],
            children: inlineChildren(node.content ?? []),
          }),
        );
        break;
      }
      case "bulletList":
        out.push(...convertList(node, numbering, listLevel, false));
        break;
      case "orderedList":
        out.push(...convertList(node, numbering, listLevel, true));
        break;
      case "blockquote":
        for (const child of node.content ?? []) {
          if (child.type === "paragraph") {
            out.push(
              new Paragraph({
                indent: { left: 720 },
                children: inlineChildren(child.content ?? []),
              }),
            );
          } else {
            out.push(...convertBlocks([child], numbering, listLevel));
          }
        }
        break;
      case "codeBlock":
        out.push(
          new Paragraph({
            shading: { fill: "F4F4F5" },
            children: [
              new TextRun({
                text: textOf(node),
                font: "Courier New",
                size: 20,
              }),
            ],
          }),
        );
        break;
      case "horizontalRule":
        out.push(new Paragraph({ text: "————————————————", alignment: AlignmentType.CENTER }));
        break;
      case "image":
        out.push(new Paragraph({ children: [imageRun(node)] }));
        break;
      case "table":
        out.push(convertTable(node));
        break;
      default:
        // 未知块：降级为纯文本，避免丢内容
        if (textOf(node)) out.push(new Paragraph({ text: textOf(node) }));
    }
  }
  return out;
}

function convertList(
  node: TiptapNode,
  numbering: Numbering[],
  level: number,
  ordered: boolean,
): Paragraph[] {
  const out: Paragraph[] = [];
  const safeLevel = Math.min(level, 5);
  let reference = "";
  if (ordered) {
    if (level === 0 || !numbering.length) {
      orderedCounter += 1;
      reference = `ac-ol-${orderedCounter}`;
      numbering.push({
        reference,
        levels: Array.from({ length: 6 }, (_, i) => ({
          level: i,
          format: LevelFormat.DECIMAL,
          text: `%${i + 1}.`,
          alignment: AlignmentType.LEFT,
        })),
      });
    } else {
      reference = numbering[numbering.length - 1].reference;
    }
  }

  for (const item of node.content ?? []) {
    if (item.type !== "listItem") continue;
    for (const child of item.content ?? []) {
      if (child.type === "bulletList" || child.type === "orderedList") {
        out.push(
          ...convertList(
            child,
            numbering,
            safeLevel + 1,
            child.type === "orderedList",
          ),
        );
      } else {
        out.push(
          new Paragraph({
            ...(ordered
              ? { numbering: { reference, level: safeLevel } }
              : { bullet: { level: safeLevel } }),
            children: inlineChildren(child.content ?? []),
          }),
        );
      }
    }
  }
  return out;
}

function convertTable(node: TiptapNode): Table {
  const rows = (node.content ?? [])
    .filter((row) => row.type === "tableRow")
    .map(
      (row) =>
        new TableRow({
          children: (row.content ?? [])
            .filter((cell) => cell.type === "tableCell" || cell.type === "tableHeader")
            .map(
              (cell) =>
                new TableCell({
                  columnSpan:
                    typeof cell.attrs?.colspan === "number" ? Math.max(1, cell.attrs.colspan) : 1,
                  children: convertBlocks(cell.content ?? [], [], 0).filter(
                    (child): child is Paragraph => child instanceof Paragraph,
                  ),
                }),
            ),
        }),
    );
  return new Table({ rows });
}

function inlineChildren(nodes: TiptapNode[]): Inline[] {
  const out: Inline[] = [];
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      out.push(new TextRun({ break: 1 }));
      continue;
    }
    if (node.type === "image") {
      out.push(imageRun(node));
      continue;
    }
    if (node.text == null) {
      // 未知内联容器：递归展开，避免丢文字
      if (node.content?.length) out.push(...inlineChildren(node.content));
      continue;
    }

    const marks = new Set((node.marks ?? []).map((m) => m.type));
    const link = (node.marks ?? []).find((m) => m.type === "link");
    const run = new TextRun({
      text: node.text,
      bold: marks.has("bold"),
      italics: marks.has("italic"),
      underline: marks.has("underline") ? {} : undefined,
      strike: marks.has("strike"),
      font: marks.has("code") ? "Courier New" : undefined,
      shading: marks.has("code") ? { fill: "F4F4F5" } : undefined,
    });

    const href = typeof link?.attrs?.href === "string" ? link.attrs.href : null;
    if (href && /^(https?:|mailto:)/i.test(href)) {
      out.push(new ExternalHyperlink({ link: href, children: [run] }));
    } else {
      out.push(run);
    }
  }
  return out;
}

function imageRun(node: TiptapNode): ImageRun {
  const src = typeof node.attrs?.src === "string" ? node.attrs.src : "";
  const match = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(src);
  if (!match) throw new AppError("图片格式不支持，仅支持 PNG/JPG/GIF/BMP");
  const ext = match[1].toLowerCase();
  const type = ext === "jpeg" || ext === "jpg" ? "jpg" : ext === "gif" ? "gif" : ext === "bmp" ? "bmp" : "png";
  const data = Buffer.from(match[2], "base64");
  return new ImageRun({
    type,
    data,
    transformation: { width: 400, height: 300 },
  });
}

function textOf(node: TiptapNode): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(textOf).join(node.type === "paragraph" ? "\n" : "");
}
