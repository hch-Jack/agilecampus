import { NextResponse } from "next/server";
import { generateObject } from "ai";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { getDocumentAccess } from "@/lib/documents/access";
import { assertSameOrigin, documentErrorResponse } from "@/lib/documents/http";
import { getModel } from "@/lib/agent/model";
import { ForbiddenError } from "@/lib/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ documentId: string }> };

const bodySchema = z.object({
  instruction: z.string().trim().min(1).max(2000),
  content: z.string().min(1).max(120_000),
  selection: z.string().max(20_000).optional(),
});

const scalar = z.union([z.string(), z.number(), z.boolean()]).transform((v) => String(v));

const replacementsSchema = z.object({
  summary: z.string(),
  edits: z
    .array(
      z.object({
        find: scalar.pipe(z.string().min(1)),
        replace: scalar,
        note: z.string().optional(),
      }),
    )
    .max(40)
    .default([]),
});

const cellsSchema = z.object({
  summary: z.string(),
  edits: z
    .array(
      z.object({
        sheet: z.coerce.number().int().min(0).optional(),
        a1: z.string().trim().min(1),
        input: scalar,
        note: z.string().optional(),
      }),
    )
    .max(80)
    .default([]),
});

const REPLACE_SYSTEM = `你是严谨的文档编辑助手。用户会给你文档内容和一条修改指令。
必须以 JSON 对象返回结果（json 字段结构见下），不要输出任何解释性文字。
只返回最小必要的修改，不要改写未要求的内容。
每条修改必须给出：
- find：在给定文档内容中**原样出现**的连续文本（区分大小写，不能是正则，尽量唯一，通常 1~2 句）
- replace：替换后的文本
- note：一句话说明（可选）
如果无法完成，edits 返回空数组，并在 summary 说明原因。
不要臆造文档中不存在的文字。
返回的 JSON 形状必须严格是：
{"summary":"一句话说明","edits":[{"find":"原文片段","replace":"替换后","note":"可选说明"}]}`;

const CELL_SYSTEM = `你是严谨的电子表格编辑助手。用户会给你工作簿的 Markdown 内容和一条修改指令。
必须以 JSON 对象返回结果，不要输出任何解释性文字。
只返回需要改动的单元格：
- sheet：0 开始的工作表序号（通常是 0）
- a1：A1 地址，如 B2
- input：单元格的新内容；公式以 = 开头
- note：一句话说明（可选）
不要改动与指令无关的单元格；不要输出解释。
如果无法完成，edits 返回空数组，并在 summary 说明原因。
返回的 JSON 形状必须严格是：
{"summary":"一句话说明","edits":[{"sheet":0,"a1":"B1","input":"新内容","note":"可选说明"}]}`;

export async function POST(req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  try {
    assertSameOrigin(req);
  } catch (e) {
    return documentErrorResponse(e);
  }

  const { documentId } = await ctx.params;
  if (!z.uuid().safeParse(documentId).success) {
    return NextResponse.json({ error: "文档不存在" }, { status: 404 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "AI 参数不正确" }, { status: 400 });

  try {
    const access = await getDocumentAccess(documentId, session.user.id);
    if (!access) throw new ForbiddenError("文档不存在或你没有访问权限");
    if (!access.canEdit) throw new ForbiddenError("你没有该文档的编辑权限");

    const { instruction, content, selection } = parsed.data;
    const isSheet = access.document.format === "sheet";
    const prompt = [
      selection
        ? `用户选中的片段（修改优先针对它）：\n<<<\n${selection}\n>>>`
        : "用户没有选中片段，修改针对整份内容。",
      `用户指令：${instruction}`,
      `当前内容：\n<<<\n${content}\n>>>`,
    ].join("\n\n");

    const result = await generateObject({
      model: getModel(),
      schema: isSheet ? cellsSchema : replacementsSchema,
      system: isSheet ? CELL_SYSTEM : REPLACE_SYSTEM,
      prompt,
      maxRetries: 0,
    });

    return NextResponse.json({
      kind: isSheet ? "cells" : "replacements",
      ...result.object,
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return documentErrorResponse(e);
    console.error("[/api/documents/ai-edits] 生成失败:", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "AI 生成修改建议失败，请稍后重试" },
      { status: 502 },
    );
  }
}
