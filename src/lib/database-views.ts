// 任务数据库视图配置：项目共享（D3）。config 结构在此收口——zod 形状校验 + 容错归一
// （剥离失效字段引用），避免脏配置炸掉渲染；结构不标进 schema（同 dashboardLayout 惯例）。
//
// 默认视图派生不落库（D4）：无持久视图时返回内置「表格/看板/时间线」（id=null）；
// 持久视图按 kind 补齐缺失的内置视图；首次编辑经 saveView 落库后即以库内为准。
// 视图写权限与任务写一致（admin/student，teacher 只读）。
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { databaseProperties, projectViews, type ViewKind } from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser, requireProjectTaskWrite } from "./project";

export const VIEW_KINDS = ["table", "board", "timeline"] as const satisfies readonly ViewKind[];

// 原生字段键（表格列显隐/筛选/排序可引用）。自定义属性以 `prop:<属性id>` 引用
export const NATIVE_FIELD_KEYS = [
  "title",
  "status",
  "priority",
  "assignee",
  "milestone",
  "label",
  "startDate",
  "dueDate",
] as const;
export type NativeFieldKey = (typeof NATIVE_FIELD_KEYS)[number];
export type FieldKey = NativeFieldKey | `prop:${string}`;

export type FilterClause = { id: string; field: FieldKey; op: string; value?: unknown };
export type SortClause = { field: FieldKey; dir: "asc" | "desc" };

export type TaskViewConfig = {
  /** 仅 board 视图有意义：原生四类或 `prop:<id>`（PR3 收紧为 GroupBy 联合） */
  groupBy?: string;
  filters?: FilterClause[];
  sorts?: SortClause[];
  hiddenColumns?: string[];
};

export type ProjectView = {
  /** null = 派生的内置默认视图（首次编辑才落库） */
  id: string | null;
  kind: ViewKind;
  name: string;
  config: TaskViewConfig;
  position: number;
};

const NAME_MAX = 30;
const FILTER_MAX = 10;
const SORT_MAX = 2;
const HIDDEN_MAX = 50;

const filterClauseSchema = z.object({
  id: z.string().min(1).max(64),
  field: z.string().min(1).max(80),
  op: z.string().min(1).max(24),
  // zod v4 的 unknown 不再隐式可选，须显式 optional，否则缺 value 的子句炸掉整包归一
  value: z.unknown().optional(),
});
const sortClauseSchema = z.object({
  field: z.string().min(1).max(80),
  dir: z.enum(["asc", "desc"]),
});
const configSchema = z.object({
  groupBy: z.string().min(1).max(80).optional(),
  filters: z.array(filterClauseSchema).optional(),
  sorts: z.array(sortClauseSchema).optional(),
  hiddenColumns: z.array(z.string().min(1).max(80)).optional(),
});

const BOARD_GROUP_NATIVE = ["status", "assignee", "priority", "milestone"] as const;

// 原生键放行；`prop:<id>` 必须指向当前项目的属性；其余剔除
function fieldOk(field: string, validPropIds: Set<string>): boolean {
  if (field.startsWith("prop:")) return validPropIds.has(field.slice(5));
  return (NATIVE_FIELD_KEYS as readonly string[]).includes(field);
}

/** 容错归一：形状非法的子配置整体忽略，引用已删属性的子句剔除，数组截到上限 */
export function normalizeConfig(raw: unknown, validPropIds: Set<string>): TaskViewConfig {
  const parsed = configSchema.safeParse(raw ?? {});
  if (!parsed.success) return {};
  const c = parsed.data;
  const out: TaskViewConfig = {};
  if (c.groupBy) {
    const g = c.groupBy;
    const ok =
      (BOARD_GROUP_NATIVE as readonly string[]).includes(g) ||
      (g.startsWith("prop:") && validPropIds.has(g.slice(5)));
    if (ok) out.groupBy = g;
  }
  const filters = c.filters
    ?.filter((f) => fieldOk(f.field, validPropIds))
    .slice(0, FILTER_MAX)
    .map((f) => ({ ...f, field: f.field as FieldKey }));
  if (filters?.length) out.filters = filters;
  const sorts = c.sorts
    ?.filter((s) => fieldOk(s.field, validPropIds))
    .slice(0, SORT_MAX)
    .map((s) => ({ ...s, field: s.field as FieldKey }));
  if (sorts?.length) out.sorts = sorts;
  const hidden = [...new Set(c.hiddenColumns?.filter((f) => fieldOk(f, validPropIds)) ?? [])].slice(
    0,
    HIDDEN_MAX,
  );
  if (hidden.length) out.hiddenColumns = hidden;
  return out;
}

const DEFAULT_VIEWS: { kind: ViewKind; name: string }[] = [
  { kind: "table", name: "表格" },
  { kind: "board", name: "看板" },
  { kind: "timeline", name: "时间线" },
];

/** 列视图（项目共享）。持久视图在前（按 position），缺 kind 的内置默认视图派生补在后面 */
export async function listProjectViews(actorId: string, projectId: string): Promise<ProjectView[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();

  const defs = await db
    .select({ id: databaseProperties.id })
    .from(databaseProperties)
    .where(eq(databaseProperties.projectId, projectId));
  const validPropIds = new Set(defs.map((d) => d.id));

  const rows = await db
    .select()
    .from(projectViews)
    .where(eq(projectViews.projectId, projectId))
    .orderBy(asc(projectViews.position), asc(projectViews.createdAt));
  const persisted: ProjectView[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    name: r.name,
    config: normalizeConfig(r.config, validPropIds),
    position: r.position,
  }));
  const missing = DEFAULT_VIEWS.filter((d) => !persisted.some((p) => p.kind === d.kind));
  return [
    ...persisted,
    ...missing.map((d, i) => ({
      id: null as string | null,
      kind: d.kind,
      name: d.name,
      config: {} as TaskViewConfig,
      position: persisted.length + i,
    })),
  ];
}

async function loadDefIds(projectId: string): Promise<Set<string>> {
  const defs = await db
    .select({ id: databaseProperties.id })
    .from(databaseProperties)
    .where(eq(databaseProperties.projectId, projectId));
  return new Set(defs.map((d) => d.id));
}

/**
 * 新建或更新视图。id 缺省 = 新建（编辑派生的默认视图即走此路径落库）；
 * id 提供时只改 name/config（kind 创建后不可变）。config 全量替换（last-writer-wins）。
 */
export async function saveView(
  actorId: string,
  projectId: string,
  input: { id?: string; kind: ViewKind; name: string; config?: unknown },
): Promise<ProjectView> {
  await requireProjectTaskWrite(actorId, projectId);
  const name = input.name.trim();
  if (!name) throw new AppError("视图名不可为空");
  if (name.length > NAME_MAX) throw new AppError(`视图名超过 ${NAME_MAX} 字`);
  const config = normalizeConfig(input.config ?? {}, await loadDefIds(projectId));

  if (input.id) {
    const [row] = await db
      .select()
      .from(projectViews)
      .where(and(eq(projectViews.id, input.id), eq(projectViews.projectId, projectId)));
    if (!row) throw new AppError("视图不存在或已删除");
    const [updated] = await db
      .update(projectViews)
      .set({ name, config, updatedAt: sql`now()` })
      .where(eq(projectViews.id, row.id))
      .returning();
    return { id: updated.id, kind: updated.kind, name: updated.name, config, position: updated.position };
  }

  const [{ maxPos }] = await db
    .select({ maxPos: sql<number>`coalesce(max(${projectViews.position}), -1)` })
    .from(projectViews)
    .where(eq(projectViews.projectId, projectId));
  const [row] = await db
    .insert(projectViews)
    .values({
      projectId,
      kind: input.kind,
      name,
      config,
      position: Number(maxPos) + 1,
      createdById: actorId,
    })
    .returning();
  return { id: row.id, kind: row.kind, name: row.name, config, position: row.position };
}

export async function renameView(
  actorId: string,
  projectId: string,
  viewId: string,
  name: string,
): Promise<ProjectView> {
  await requireProjectTaskWrite(actorId, projectId);
  const trimmed = name.trim();
  if (!trimmed) throw new AppError("视图名不可为空");
  if (trimmed.length > NAME_MAX) throw new AppError(`视图名超过 ${NAME_MAX} 字`);
  const [row] = await db
    .select()
    .from(projectViews)
    .where(and(eq(projectViews.id, viewId), eq(projectViews.projectId, projectId)));
  if (!row) throw new AppError("视图不存在或已删除");
  const [updated] = await db
    .update(projectViews)
    .set({ name: trimmed, updatedAt: sql`now()` })
    .where(eq(projectViews.id, viewId))
    .returning();
  return {
    id: updated.id,
    kind: updated.kind,
    name: updated.name,
    config: normalizeConfig(updated.config, await loadDefIds(projectId)),
    position: updated.position,
  };
}

export async function deleteView(actorId: string, projectId: string, viewId: string) {
  await requireProjectTaskWrite(actorId, projectId);
  const deleted = await db
    .delete(projectViews)
    .where(and(eq(projectViews.id, viewId), eq(projectViews.projectId, projectId)))
    .returning({ id: projectViews.id });
  if (deleted.length === 0) throw new AppError("视图不存在或已删除");
}

/** 重排持久视图的 position（派生默认视图不可重排，由调用方只传库内 id） */
export async function reorderViews(actorId: string, projectId: string, orderedIds: string[]) {
  await requireProjectTaskWrite(actorId, projectId);
  const rows = await db
    .select({ id: projectViews.id })
    .from(projectViews)
    .where(eq(projectViews.projectId, projectId));
  const current = rows.map((r) => r.id).sort();
  const incoming = [...orderedIds].sort();
  if (
    orderedIds.length !== rows.length ||
    current.some((id, i) => id !== incoming[i]) ||
    new Set(orderedIds).size !== orderedIds.length
  ) {
    throw new AppError("视图列表不完整或有重复");
  }
  for (const [i, id] of orderedIds.entries()) {
    await db
      .update(projectViews)
      .set({ position: i, updatedAt: sql`now()` })
      .where(eq(projectViews.id, id));
  }
}
