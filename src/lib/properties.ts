// 任务数据库自定义属性引擎：属性定义 CRUD + 值校验/归一 + tasks.properties JSONB 读写。
//
// 存储模型（D1）：定义在本表的行上；值以 `Record<属性id, 值>` 存在 tasks.properties JSONB。
// 写值走 SQL 键级合并（`||` 合并 / `-` 删键，D5），两个并发行内编辑不同属性互不丢键；
// 删属性/删选项时事务剥离任务上已存的值（D7）。
// 值形状按类型各异：text=字符串、number=数字、select=选项id、multi_select=选项id数组、
// date=YYYY-MM-DD、person=团队成员userId（v1 单人）、checkbox=只存 true。
// 写权限口径与任务写一致（admin/student，teacher 只读）。
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db, type DbTx } from "@/db";
import {
  databaseProperties,
  tasks,
  users,
  type PropertyOption,
  type PropertyType,
} from "@/db/schema";
import { AppError, ForbiddenError } from "./errors";
import { getProjectForUser, requireProjectTaskWrite } from "./project";
import { getTeamMembership } from "./team";
import { recordTaskActivity } from "./activity";
import { LABEL_COLORS } from "./board-columns";

type Exec = typeof db | DbTx;

export type PropertyDef = typeof databaseProperties.$inferSelect;

/** 合法值；undefined 表示「清空该键」（空文本/空数组/checkbox false） */
export type PropertyValue = string | number | true | string[];

export type ResolvedPropertyValues = {
  /** 键 → 校验后的值，整键 SQL `||` 合并 */
  sets: Record<string, PropertyValue>;
  /** 要删除的键，SQL `-` 逐键剥离 */
  clears: string[];
};

const TEXT_MAX = 500;
const NAME_MAX = 30;
const OPTION_NAME_MAX = 20;
const OPTION_MAX = 50;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 同 lib/project.ts 的 isValidDate 口径：格式 + 真实存在之日（2026-02-30 不放行）
function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const SELECT_TYPES: readonly PropertyType[] = ["select", "multi_select"];

// ---------------------------------------------------------------- 定义校验

function normalizeDefName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new AppError("属性名不可为空");
  if (name.length > NAME_MAX) throw new AppError(`属性名超过 ${NAME_MAX} 字`);
  return name;
}

/** 校验选项列表（select/multi_select 专用），生成缺失的选项 id；返回带 id 的完整列表 */
function normalizeOptions(raw: unknown): PropertyOption[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError("单选/多选属性至少需要一个选项");
  if (raw.length > OPTION_MAX) throw new AppError(`选项最多 ${OPTION_MAX} 个`);
  const seen = new Set<string>();
  const options: PropertyOption[] = raw.map((o) => {
    if (typeof o !== "object" || o === null) throw new AppError("选项格式不正确");
    const { id, name, color } = o as { id?: unknown; name?: unknown; color?: unknown };
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new AppError("选项名不可为空");
    if (trimmed.length > OPTION_NAME_MAX) throw new AppError(`选项名超过 ${OPTION_NAME_MAX} 字`);
    const key = trimmed.toLowerCase();
    if (seen.has(key)) throw new AppError(`选项名重复：${trimmed}`);
    seen.add(key);
    if (typeof color !== "string" || !(LABEL_COLORS as readonly string[]).includes(color))
      throw new AppError("选项颜色无效");
    return { id: typeof id === "string" && id ? id : crypto.randomUUID(), name: trimmed, color };
  });
  return options;
}

async function assertDefNameFree(projectId: string, name: string, exceptId?: string) {
  const defs = await db
    .select({ id: databaseProperties.id, name: databaseProperties.name })
    .from(databaseProperties)
    .where(eq(databaseProperties.projectId, projectId));
  const lower = name.toLowerCase();
  if (defs.some((d) => d.name.toLowerCase() === lower && d.id !== exceptId))
    throw new AppError("同名属性已存在");
}

async function getDefOrFail(projectId: string, defId: string): Promise<PropertyDef> {
  const [def] = await db
    .select()
    .from(databaseProperties)
    .where(and(eq(databaseProperties.id, defId), eq(databaseProperties.projectId, projectId)));
  if (!def) throw new AppError("属性不存在或已删除");
  return def;
}

// ---------------------------------------------------------------- 定义 CRUD

export async function listPropertyDefs(actorId: string, projectId: string) {
  // 读定义只需项目成员（teacher 也可读）；写定义才要求 admin/student
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  return db
    .select()
    .from(databaseProperties)
    .where(eq(databaseProperties.projectId, projectId))
    .orderBy(asc(databaseProperties.position), asc(databaseProperties.createdAt));
}

export async function createPropertyDef(
  actorId: string,
  projectId: string,
  input: { name: string; type: PropertyType; options?: unknown },
) {
  await requireProjectTaskWrite(actorId, projectId);
  const name = normalizeDefName(input.name);
  await assertDefNameFree(projectId, name);
  let options: PropertyOption[] | null = null;
  if (SELECT_TYPES.includes(input.type)) {
    options = normalizeOptions(input.options);
  } else if (input.options != null) {
    throw new AppError("该属性类型不支持选项");
  }
  // 追加到末尾：position 取当前最大值 +1（重排时由 reorderPropertyDefs 重写为 0..n）
  const [{ maxPos }] = await db
    .select({ maxPos: sql<number>`coalesce(max(${databaseProperties.position}), -1)` })
    .from(databaseProperties)
    .where(eq(databaseProperties.projectId, projectId));
  const [def] = await db
    .insert(databaseProperties)
    .values({ projectId, name, type: input.type, options, position: Number(maxPos) + 1 })
    .returning();
  return def;
}

export async function updatePropertyDef(
  actorId: string,
  projectId: string,
  defId: string,
  patch: { name?: string; options?: unknown },
) {
  await requireProjectTaskWrite(actorId, projectId);
  const def = await getDefOrFail(projectId, defId);

  // 类型创建后不可改（D7）：接口层根本不提供 type 入参，这里只处理名与选项
  let name = def.name;
  if (patch.name !== undefined) {
    name = normalizeDefName(patch.name);
    await assertDefNameFree(projectId, name, defId);
  }

  // 事务：更新定义 + 剥离被删选项在任务上已存的值
  return db.transaction(async (tx) => {
    let removed: Set<string> | null = null;
    if (patch.options !== undefined) {
      if (!SELECT_TYPES.includes(def.type)) throw new AppError("该属性类型不支持选项");
      const nextOptions = normalizeOptions(patch.options);
      const nextIds = new Set(nextOptions.map((o) => o.id));
      removed = new Set((def.options ?? []).filter((o) => !nextIds.has(o.id)).map((o) => o.id));
      await tx
        .update(databaseProperties)
        .set({ name, options: nextOptions, updatedAt: sql`now()` })
        .where(eq(databaseProperties.id, defId));
      if (removed.size > 0) await stripOptionValues(tx, projectId, defId, removed);
    } else if (patch.name !== undefined) {
      await tx
        .update(databaseProperties)
        .set({ name, updatedAt: sql`now()` })
        .where(eq(databaseProperties.id, defId));
    }
    const [updated] = await tx
      .select()
      .from(databaseProperties)
      .where(eq(databaseProperties.id, defId));
    return updated;
  });
}

export async function deletePropertyDef(actorId: string, projectId: string, defId: string) {
  await requireProjectTaskWrite(actorId, projectId);
  await getDefOrFail(projectId, defId);
  await db.transaction(async (tx) => {
    await tx.delete(databaseProperties).where(eq(databaseProperties.id, defId));
    // 值不在本表（存 tasks.properties），无外键级联，须手动剥离键
    await stripDefKeys(tx, projectId, [defId]);
  });
}

export async function reorderPropertyDefs(
  actorId: string,
  projectId: string,
  orderedIds: string[],
) {
  await requireProjectTaskWrite(actorId, projectId);
  const defs = await db
    .select({ id: databaseProperties.id })
    .from(databaseProperties)
    .where(eq(databaseProperties.projectId, projectId));
  const current = defs.map((d) => d.id).sort();
  const incoming = [...orderedIds].sort();
  if (
    orderedIds.length !== defs.length ||
    current.some((id, i) => id !== incoming[i]) ||
    new Set(orderedIds).size !== orderedIds.length
  ) {
    throw new AppError("属性列表不完整或有重复");
  }
  await db.transaction(async (tx) => {
    for (const [i, id] of orderedIds.entries()) {
      await tx
        .update(databaseProperties)
        .set({ position: i, updatedAt: sql`now()` })
        .where(eq(databaseProperties.id, id));
    }
  });
}

// ---------------------------------------------------------------- 值校验

/**
 * 校验并归一一个属性值。返回 undefined = 清空该键（空文本/空数组/checkbox false）。
 * person 型需查团队成员（须是项目所属团队的成员，口径同 validateAssignee）。
 */
async function normalizePropertyValue(
  def: { id: string; name: string; type: PropertyType; options: PropertyOption[] | null },
  raw: unknown,
  teamId: string,
): Promise<PropertyValue | undefined> {
  const label = `属性「${def.name}」`;
  switch (def.type) {
    case "text": {
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "string") throw new AppError(`${label}需为文本`);
      const v = raw.trim();
      if (!v) return undefined;
      if (v.length > TEXT_MAX) throw new AppError(`${label}的文本超过 ${TEXT_MAX} 字`);
      return v;
    }
    case "number": {
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "number" || !Number.isFinite(raw)) throw new AppError(`${label}需为数字`);
      return raw;
    }
    case "select": {
      if (raw === null || raw === undefined || raw === "") return undefined;
      if (typeof raw !== "string") throw new AppError(`${label}的值无效`);
      if (!(def.options ?? []).some((o) => o.id === raw))
        throw new AppError(`${label}的选项不存在或已删除`);
      return raw;
    }
    case "multi_select": {
      if (raw === null || raw === undefined) return undefined;
      if (!Array.isArray(raw)) throw new AppError(`${label}需为选项列表`);
      const ids: string[] = [];
      for (const v of raw) {
        if (typeof v !== "string" || !(def.options ?? []).some((o) => o.id === v))
          throw new AppError(`${label}的选项不存在或已删除`);
        if (!ids.includes(v)) ids.push(v);
      }
      if (ids.length === 0) return undefined;
      return ids;
    }
    case "date": {
      if (raw === null || raw === undefined || raw === "") return undefined;
      if (typeof raw !== "string" || !isValidDate(raw)) throw new AppError(`${label}日期格式不正确`);
      return raw;
    }
    case "person": {
      if (raw === null || raw === undefined || raw === "") return undefined;
      if (typeof raw !== "string") throw new AppError(`${label}的值无效`);
      if (!(await getTeamMembership(raw, teamId)))
        throw new AppError(`${label}的人员不是团队成员`);
      return raw;
    }
    case "checkbox": {
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "boolean") throw new AppError(`${label}需为布尔值`);
      // 只存 true：false/缺省即未勾选，避免 jsonb 里堆积无意义的 false
      return raw ? true : undefined;
    }
  }
}

/** 校验一批属性值（键=属性 id）。键必须全部是本项目已定义的属性；未知键/已删属性直接报错 */
export async function resolveTaskPropertyValues(
  projectId: string,
  teamId: string,
  values: Record<string, unknown>,
): Promise<ResolvedPropertyValues> {
  const keys = Object.keys(values);
  if (keys.length === 0) return { sets: {}, clears: [] };
  const defs = await db
    .select()
    .from(databaseProperties)
    .where(and(eq(databaseProperties.projectId, projectId), inArray(databaseProperties.id, keys)));
  if (defs.length !== new Set(keys).size) throw new AppError("属性不存在或已删除");
  const resolved: ResolvedPropertyValues = { sets: {}, clears: [] };
  for (const def of defs) {
    const v = await normalizePropertyValue(def, values[def.id], teamId);
    if (v === undefined) resolved.clears.push(def.id);
    else resolved.sets[def.id] = v;
  }
  return resolved;
}

// ---------------------------------------------------------------- 值写入

/** 键级 SQL 合并（D5）：不清包覆盖，两个并发编辑不同属性互不丢键 */
function mergeExpr(resolved: ResolvedPropertyValues) {
  let expr = sql`coalesce(${tasks.properties}, '{}'::jsonb)`;
  for (const k of resolved.clears) expr = sql`${expr} - ${k}::text`;
  if (Object.keys(resolved.sets).length > 0)
    expr = sql`${expr} || ${JSON.stringify(resolved.sets)}::jsonb`;
  return expr;
}

/** 应用已校验的值（无动态流记录，供 createTask 建任务时带初始值复用） */
export async function applyTaskProperties(
  exec: Exec,
  taskId: string,
  resolved: ResolvedPropertyValues,
) {
  if (resolved.clears.length === 0 && Object.keys(resolved.sets).length === 0) return;
  await exec
    .update(tasks)
    .set({ properties: mergeExpr(resolved), updatedAt: sql`now()` })
    .where(eq(tasks.id, taskId));
}

/**
 * 写任务属性（行内编辑/看板拖拽入口）：权限 → 校验 → SQL 键级合并 → 逐属性记任务动态。
 * 返回合并后的完整 properties（供前端 store 直接对齐）。
 */
export async function setTaskProperties(
  actorId: string,
  taskId: string,
  values: Record<string, unknown>,
  opts?: { tx?: DbTx },
): Promise<Record<string, unknown>> {
  const exec = opts?.tx ?? db;
  const [task] = await exec.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) throw new AppError("任务不存在");
  const access = await requireProjectTaskWrite(actorId, task.projectId);
  const resolved = await resolveTaskPropertyValues(task.projectId, access.project.teamId, values);
  if (resolved.clears.length === 0 && Object.keys(resolved.sets).length === 0)
    return (task.properties ?? {}) as Record<string, unknown>;

  const oldProps = (task.properties ?? {}) as Record<string, unknown>;
  await applyTaskProperties(exec, taskId, resolved);
  const [updated] = await exec
    .select({ properties: tasks.properties })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  const newProps = (updated?.properties ?? {}) as Record<string, unknown>;

  // 动态流：逐属性 diff（值转展示文本，读端免映射）。person 型取名字、select 取选项名。
  const defs = await exec
    .select()
    .from(databaseProperties)
    .where(
      and(eq(databaseProperties.projectId, task.projectId), inArray(databaseProperties.id, Object.keys(values))),
    );
  const personIds = new Set<string>();
  for (const def of defs) {
    if (def.type !== "person") continue;
    for (const v of [oldProps[def.id], newProps[def.id]]) {
      if (typeof v === "string" && v) personIds.add(v);
    }
  }
  const nameMap = personIds.size
    ? new Map(
        (
          await exec
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(inArray(users.id, [...personIds]))
        ).map((r) => [r.id, r.name]),
      )
    : new Map<string, string>();

  const changes: { field: string; oldValue: string; newValue: string }[] = [];
  for (const def of defs) {
    const before = oldProps[def.id];
    const after = newProps[def.id];
    if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue;
    changes.push({
      field: def.name,
      oldValue: formatPropertyValue(def, before, nameMap),
      newValue: formatPropertyValue(def, after, nameMap),
    });
  }
  if (changes.length > 0)
    await recordTaskActivity(
      exec,
      changes.map((c) => ({
        taskId,
        actorId,
        type: "field",
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
      })),
    );
  return newProps;
}

// ---------------------------------------------------------------- 展示文本

/** 属性值的动态流展示文本。person 传名字映射；未知 id 归一为占位文案 */
function formatPropertyValue(
  def: { type: PropertyType; options: PropertyOption[] | null },
  value: unknown,
  personNames: Map<string, string>,
): string {
  if (value === null || value === undefined) return "无";
  switch (def.type) {
    case "text":
    case "number":
    case "date":
      return String(value);
    case "select":
      return (
        (def.options ?? []).find((o) => o.id === value)?.name ?? "未知选项"
      );
    case "multi_select":
      return Array.isArray(value) && value.length
        ? value
            .map((v) => (def.options ?? []).find((o) => o.id === v)?.name ?? "未知选项")
            .join("、")
        : "无";
    case "person":
      return typeof value === "string" ? (personNames.get(value) ?? "未知成员") : "无";
    case "checkbox":
      return value === true ? "是" : "无";
  }
}

// ---------------------------------------------------------------- 值剥离（删定义/删选项）

/** 删属性：把键从项目内所有任务的 properties 中剥离（JS 改写整包；删除低频，规模可控） */
async function stripDefKeys(exec: Exec, projectId: string, defIds: string[]) {
  const rows = await exec
    .select({ id: tasks.id, properties: tasks.properties })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.properties)));
  for (const row of rows) {
    const props = { ...((row.properties ?? {}) as Record<string, unknown>) };
    let changed = false;
    for (const k of defIds) {
      if (k in props) {
        delete props[k];
        changed = true;
      }
    }
    // 写路径统一存 {}（SQL 合并路径同样产 {}）；null 只表示从未写过
    if (changed)
      await exec.update(tasks).set({ properties: props }).where(eq(tasks.id, row.id));
  }
}

/** 删单选/多选选项：select 值命中即清键；multi_select 过滤后为空也清键 */
async function stripOptionValues(
  exec: Exec,
  projectId: string,
  defId: string,
  removed: Set<string>,
) {
  const rows = await exec
    .select({ id: tasks.id, properties: tasks.properties })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), isNotNull(tasks.properties)));
  for (const row of rows) {
    const props = { ...((row.properties ?? {}) as Record<string, unknown>) };
    const cur = props[defId];
    let next: unknown;
    if (typeof cur === "string") {
      if (!removed.has(cur)) continue;
      next = undefined; // 命中被删选项 → 清键
    } else if (Array.isArray(cur)) {
      const filtered = cur.filter((id) => !removed.has(id));
      if (filtered.length === cur.length) continue;
      next = filtered.length ? filtered : undefined;
    } else {
      continue;
    }
    if (next === undefined) delete props[defId];
    else props[defId] = next;
    // 写路径统一存 {}（与 SQL 合并路径一致）；null 只表示从未写过
    await exec.update(tasks).set({ properties: props }).where(eq(tasks.id, row.id));
  }
}
