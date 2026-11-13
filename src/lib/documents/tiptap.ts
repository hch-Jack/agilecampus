import { z } from "zod";
import { AppError } from "@/lib/errors";
import { DOCX_IMAGE_TOTAL_MAX_BYTES } from "./format";

/**
 * Tiptap JSON 的轻量校验：限制深度/节点数/文本体积/内嵌图片总量，
 * 防超大或恶意 JSON 让服务端导出 docx 时爆内存。
 */

const markSchema = z.object({
  type: z.string().max(40),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const nodeSchema: z.ZodType<TiptapNode> = z.lazy(() =>
  z.object({
    type: z.string().min(1).max(40),
    attrs: z.record(z.string(), z.unknown()).optional(),
    content: z.array(nodeSchema).optional(),
    marks: z.array(markSchema).optional(),
    text: z.string().optional(),
  }),
);

export type TiptapNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TiptapNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
};

const docSchema = z.object({ type: z.literal("doc"), content: z.array(nodeSchema).optional() });

const MAX_DEPTH = 50;
const MAX_NODES = 50_000;
const MAX_TEXT_CHARS = 5 * 1024 * 1024;

export function parseTiptapDoc(input: unknown): TiptapNode {
  const parsed = docSchema.safeParse(input);
  if (!parsed.success) throw new AppError("富文本内容格式不正确");

  let nodes = 0;
  let chars = 0;
  let imageBytes = 0;

  const walk = (node: TiptapNode, depth: number) => {
    if (depth > MAX_DEPTH) throw new AppError("富文本嵌套层级过深");
    nodes += 1;
    if (nodes > MAX_NODES) throw new AppError("富文本内容过大");
    if (node.text) chars += node.text.length;
    if (chars > MAX_TEXT_CHARS) throw new AppError("富文本文字超过 5MB 上限");
    if (node.type === "image") {
      const src = node.attrs?.src;
      if (typeof src === "string" && src.startsWith("data:image/")) {
        imageBytes += Math.floor((src.length * 3) / 4);
        if (imageBytes > DOCX_IMAGE_TOTAL_MAX_BYTES) {
          throw new AppError("文档内图片总大小不能超过 5MB");
        }
      }
    }
    for (const child of node.content ?? []) walk(child, depth + 1);
  };

  walk(parsed.data, 0);
  return parsed.data;
}

/** 从 Tiptap 文档里取纯文本（测试/搜索用） */
export function tiptapDocText(node: TiptapNode): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(tiptapDocText).join(node.type === "paragraph" ? "\n" : "");
}
