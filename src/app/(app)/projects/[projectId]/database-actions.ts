"use server";

// 任务数据库（Notion 化）的写入口：属性定义 CRUD、任务属性值、视图配置。
// 读路径不走这里——页面/组件直接调 lib（RSC 直查惯例），写路径统一过 session + zod 形状校验，
// 授权与业务校验收口在 lib/properties.ts 与 lib/database-views.ts（requireProjectTaskWrite）。

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { propertyTypeEnum, type PropertyOption, type ViewKind } from "@/db/schema";
import { LABEL_COLORS } from "@/lib/board-columns";
import {
  createPropertyDef,
  deletePropertyDef,
  listPropertyDefs,
  reorderPropertyDefs,
  setTaskProperties,
  updatePropertyDef,
} from "@/lib/properties";
import { deleteView, renameView, reorderViews, saveView } from "@/lib/database-views";

// 结果形状：成功带数据、失败带可直接展示的中文错误（store 据此回滚乐观态并提示）
export type DefResult = { ok: true; def: Awaited<ReturnType<typeof createPropertyDef>> } | { error: string };
export type ViewsResult = { ok: true; view: Awaited<ReturnType<typeof saveView>> } | { error: string };
export type PropsResult = { ok: true; properties: Record<string, unknown> } | { error: string };
export type OkResult = { ok: true } | { error: string };

const defIdListSchema = z.array(z.uuid()).min(1);

// 选项入参：id 可缺省（新建由 lib 生成）；更新时前端回传已有 id 保证稳定（D7）
const optionSchema = z.object({
  id: z.string().min(1).max(64).optional(),
  name: z.string().trim().min(1, "选项名不可为空").max(20, "选项名超过 20 字"),
  color: z.enum(LABEL_COLORS),
});

const createDefSchema = z.object({
  projectId: z.uuid(),
  name: z.string().trim().min(1, "属性名不可为空").max(30, "属性名超过 30 字"),
  type: z.enum(propertyTypeEnum.enumValues),
  options: z.array(optionSchema).max(50).optional(),
});

export async function createPropertyDefAction(input: unknown): Promise<DefResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = createDefSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const def = await createPropertyDef(session.user.id, parsed.data.projectId, {
      name: parsed.data.name,
      type: parsed.data.type,
      options: parsed.data.options,
    });
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, def };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

const updateDefSchema = z.object({
  projectId: z.uuid(),
  defId: z.uuid(),
  name: z.string().trim().min(1, "属性名不可为空").max(30, "属性名超过 30 字").optional(),
  options: z.array(optionSchema).max(50).optional(),
});

export async function updatePropertyDefAction(input: unknown): Promise<DefResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = updateDefSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const def = await updatePropertyDef(session.user.id, parsed.data.projectId, parsed.data.defId, {
      name: parsed.data.name,
      options: parsed.data.options,
    });
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, def };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

const defTargetSchema = z.object({
  projectId: z.uuid(),
  defId: z.uuid(),
});

export async function deletePropertyDefAction(input: unknown): Promise<OkResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = defTargetSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await deletePropertyDef(session.user.id, parsed.data.projectId, parsed.data.defId);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export async function reorderPropertyDefsAction(input: unknown): Promise<OkResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = z
    .object({ projectId: z.uuid(), defIds: defIdListSchema })
    .safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await reorderPropertyDefs(session.user.id, parsed.data.projectId, parsed.data.defIds);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

// 任务属性值：行内编辑/看板拖拽/时间线以外的表格编辑统一入口。null/空串/空数组=清值
const setPropsSchema = z.object({
  projectId: z.uuid(),
  taskId: z.uuid(),
  values: z.record(z.uuid(), z.unknown()),
});

export async function setTaskPropertiesAction(input: unknown): Promise<PropsResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = setPropsSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  if (Object.keys(parsed.data.values).length === 0) return { error: "参数无效" };
  try {
    const properties = await setTaskProperties(session.user.id, parsed.data.taskId, parsed.data.values);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, properties };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- 视图

const viewKindSchema = z.enum(["table", "board", "timeline"] satisfies readonly ViewKind[]);

const saveViewSchema = z.object({
  projectId: z.uuid(),
  /** 缺省 = 新建（编辑派生的内置默认视图即走此路径落库） */
  id: z.uuid().optional(),
  kind: viewKindSchema,
  name: z.string().trim().min(1, "视图名不可为空").max(30, "视图名超过 30 字"),
  config: z.unknown().optional(),
});

export async function saveViewAction(input: unknown): Promise<ViewsResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = saveViewSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const view = await saveView(session.user.id, parsed.data.projectId, {
      id: parsed.data.id,
      kind: parsed.data.kind,
      name: parsed.data.name,
      config: parsed.data.config,
    });
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, view };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

const viewTargetSchema = z.object({
  projectId: z.uuid(),
  viewId: z.uuid(),
});

export async function renameViewAction(input: unknown): Promise<ViewsResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = z
    .object({ projectId: z.uuid(), viewId: z.uuid(), name: z.string().trim().min(1, "视图名不可为空").max(30, "视图名超过 30 字") })
    .safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  try {
    const view = await renameView(session.user.id, parsed.data.projectId, parsed.data.viewId, parsed.data.name);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true, view };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export async function deleteViewAction(input: unknown): Promise<OkResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = viewTargetSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await deleteView(session.user.id, parsed.data.projectId, parsed.data.viewId);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export async function reorderViewsAction(input: unknown): Promise<OkResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  const parsed = z
    .object({ projectId: z.uuid(), viewIds: defIdListSchema })
    .safeParse(input);
  if (!parsed.success) return { error: "参数无效" };
  try {
    await reorderViews(session.user.id, parsed.data.projectId, parsed.data.viewIds);
    revalidatePath(`/projects/${parsed.data.projectId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

// listPropertyDefs 供 store 刷新定义用（新建属性后无需整页刷新）
export async function listPropertyDefsAction(input: unknown) {
  const session = await auth();
  if (!session?.user) return null;
  const parsed = z.object({ projectId: z.uuid() }).safeParse(input);
  if (!parsed.success) return null;
  try {
    return await listPropertyDefs(session.user.id, parsed.data.projectId);
  } catch {
    return null;
  }
}

// 选项入参形状供前端复用（"use server" 文件只放函数，形状经 lib 类型导出）
export type PropertyOptionInput = PropertyOption & { id?: string };
