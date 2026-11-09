import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  skills,
  type SkillFile,
  type SkillSource,
} from "@/db/schema";
import { AppError, NotFoundError, isUniqueViolation } from "@/lib/errors";
import { normalizeContextContent } from "@/lib/personal-context";
import {
  BUILTIN_SKILLS,
  type BuiltinSkill,
} from "@/lib/agent/skill-builtins";

/**
 * 技能的数据层：内置 + 用户自建 / 导入 / 助手代写。
 *
 * 收口原则与 personal-context 相同：**userId 一律由调用方传 actorId**，
 * 不接受草案或表单里的 owner 字段；查询、改、删都带 `user_id = actorId` 条件。
 *
 * 技能只挂在个人助手上。项目助手的会话是团队共享的，把某人的技能读进上下文
 * 等于让队友也能看到（工具输出会落进对话记录），所以不接。
 */

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 300;
export const SKILL_INSTRUCTIONS_MAX = 20_000;
export const SKILL_MAX_FILES = 20;
export const SKILL_FILE_MAX_CHARS = 100_000;
export const SKILL_FILES_TOTAL_MAX_CHARS = 400_000;
export const SKILL_FILE_READ_MAX_CHARS = 30_000;
/** 进系统提示的技能目录上限：内置已经 5 个，用户技能再列这么多 */
export const SKILL_CATALOG_USER_LIMIT = 40;
/** 系统提示里每条描述最多多少字 */
export const SKILL_CATALOG_DESCRIPTION_LIMIT = 180;

export type SkillOrigin = "claude" | "markdown" | "json" | "agilecampus";

export type SkillRecord = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  files: SkillFile[];
  source: SkillSource;
  origin: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type SkillSummary = {
  name: string;
  description: string;
  source: SkillSource | "builtin";
  origin: string | null;
  /** 内置技能恒为启用；用户技能可停用 */
  enabled: boolean;
};

export type SkillInput = {
  name: string;
  description: string;
  instructions: string;
  files?: SkillFile[];
};

export type SkillDraft = {
  name: string;
  description: string;
  instructions: string;
  files: SkillFile[];
};

// 与 personal-context 共用同一套归一化：CRLF 折成 LF、剔除控制字符与零宽字符、再 trim。
// 技能正文同样会进模型上下文，注入载体与「个人上下文」是同一类，没必要各写一份。
function normalizeText(raw: string): string {
  return normalizeContextContent(raw);
}

/** 名称：折叠空白、去掉 / 与 \（它们会让「按名字读取」产生歧义） */
export function normalizeSkillName(raw: string): string {
  const name = normalizeText(raw).replace(/\s+/g, " ");
  if (!name) throw new AppError("技能名称不能为空");
  if (name.length > SKILL_NAME_MAX) throw new AppError(`技能名称最多 ${SKILL_NAME_MAX} 字`);
  if (/[/\\]/.test(name)) throw new AppError("技能名称不能包含斜杠");
  return name;
}

export function normalizeSkillDescription(raw: string): string {
  const description = normalizeText(raw).replace(/\s+/g, " ");
  if (!description) throw new AppError("技能描述不能为空（它决定助手何时该用这个技能）");
  if (description.length > SKILL_DESCRIPTION_MAX)
    throw new AppError(`技能描述最多 ${SKILL_DESCRIPTION_MAX} 字`);
  return description;
}

export function normalizeSkillInstructions(raw: string): string {
  const instructions = normalizeText(raw);
  if (!instructions) throw new AppError("技能正文不能为空");
  if (instructions.length > SKILL_INSTRUCTIONS_MAX)
    throw new AppError(`技能正文最多 ${SKILL_INSTRUCTIONS_MAX} 字`);
  return instructions;
}

export function normalizeSkillPath(raw: string): string {
  const path = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!path) throw new AppError("参考文件路径不能为空");
  if (path.length > 200) throw new AppError("参考文件路径过长");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path))
    throw new AppError("参考文件路径必须是相对路径");
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === ".."))
    throw new AppError(`参考文件路径不合法：${raw}`);
  return path;
}

export function normalizeSkillFiles(raw: unknown): SkillFile[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AppError("参考文件必须是数组");
  if (raw.length > SKILL_MAX_FILES)
    throw new AppError(`参考文件最多 ${SKILL_MAX_FILES} 个`);
  const seen = new Set<string>();
  let total = 0;
  const files: SkillFile[] = [];
  for (const item of raw) {
    const obj = (item ?? {}) as { path?: unknown; content?: unknown };
    if (typeof obj.path !== "string" || typeof obj.content !== "string")
      throw new AppError("参考文件格式无效（需要 path 与 content）");
    const path = normalizeSkillPath(obj.path);
    const content = obj.content.replace(/\r\n?/g, "\n");
    if (content.length > SKILL_FILE_MAX_CHARS)
      throw new AppError(`参考文件「${path}」超过 ${SKILL_FILE_MAX_CHARS} 字`);
    if (seen.has(path)) throw new AppError(`参考文件路径重复：${path}`);
    seen.add(path);
    total += content.length;
    if (total > SKILL_FILES_TOTAL_MAX_CHARS)
      throw new AppError(`参考文件总字数超过 ${SKILL_FILES_TOTAL_MAX_CHARS}`);
    files.push({ path, content });
  }
  return files;
}

/** 校验并归一化一份技能（不做数据库查询），供拟稿与落库共用 */
export function normalizeSkillDraft(input: SkillInput): SkillDraft {
  return {
    name: normalizeSkillName(input.name),
    description: normalizeSkillDescription(input.description),
    instructions: normalizeSkillInstructions(input.instructions),
    files: normalizeSkillFiles(input.files),
  };
}

function isBuiltinName(name: string): boolean {
  const lower = name.toLowerCase();
  return BUILTIN_SKILLS.some((s) => s.name.toLowerCase() === lower);
}

/**
 * 名称为用户内唯一、且不得与内置技能重名（否则 read_skill 不知道该读哪一份）。
 * 大小写不敏感：`Weekly-Report` 与 `weekly-report` 对用户而言是同一个名字。
 */
export async function assertSkillNameAvailable(
  actorId: string,
  name: string,
  excludeId?: string,
): Promise<void> {
  if (isBuiltinName(name))
    throw new AppError(`「${name}」是内置技能，请换一个名字`);
  const rows = await db
    .select({ id: skills.id, name: skills.name })
    .from(skills)
    .where(eq(skills.userId, actorId));
  const lower = name.toLowerCase();
  const clash = rows.find((r) => r.id !== excludeId && r.name.toLowerCase() === lower);
  if (clash) throw new AppError(`已有同名技能「${clash.name}」，请换一个名字`);
}

export async function createSkill(
  actorId: string,
  input: SkillInput,
  options: { source?: SkillSource; origin?: string | null } = {},
): Promise<SkillRecord> {
  const d = normalizeSkillDraft(input);
  await assertSkillNameAvailable(actorId, d.name);
  try {
    const [row] = await db
      .insert(skills)
      .values({
        userId: actorId,
        name: d.name,
        description: d.description,
        instructions: d.instructions,
        files: d.files,
        source: options.source ?? "manual",
        origin: options.origin ?? null,
      })
      .returning();
    return toRecord(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(`已有同名技能「${d.name}」，请换一个名字`);
    throw e;
  }
}

export async function listMySkills(actorId: string): Promise<SkillRecord[]> {
  const rows = await db
    .select()
    .from(skills)
    .where(eq(skills.userId, actorId))
    .orderBy(asc(skills.createdAt));
  return rows.map(toRecord);
}

export async function countMySkills(actorId: string): Promise<number> {
  const rows = await db
    .select({ id: skills.id })
    .from(skills)
    .where(eq(skills.userId, actorId));
  return rows.length;
}

export async function updateSkill(
  actorId: string,
  id: string,
  input: SkillInput,
): Promise<SkillRecord> {
  const d = normalizeSkillDraft({ ...input, files: input.files ?? [] });
  await assertSkillNameAvailable(actorId, d.name, id);
  try {
    const [row] = await db
      .update(skills)
      .set({
        name: d.name,
        description: d.description,
        instructions: d.instructions,
        // 编辑表单不带文件时保留原参考文件；只有显式传入才覆盖
        ...(input.files !== undefined ? { files: d.files } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(skills.id, id), eq(skills.userId, actorId)))
      .returning();
    if (!row) throw new NotFoundError("技能不存在");
    return toRecord(row);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError(`已有同名技能「${d.name}」，请换一个名字`);
    throw e;
  }
}

export async function deleteSkill(actorId: string, id: string): Promise<void> {
  const rows = await db
    .delete(skills)
    .where(and(eq(skills.id, id), eq(skills.userId, actorId)))
    .returning({ id: skills.id });
  if (rows.length === 0) throw new NotFoundError("技能不存在");
}

export async function setSkillEnabled(
  actorId: string,
  id: string,
  enabled: boolean,
): Promise<void> {
  const rows = await db
    .update(skills)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(skills.id, id), eq(skills.userId, actorId)))
    .returning({ id: skills.id });
  if (rows.length === 0) throw new NotFoundError("技能不存在");
}

/**
 * 助手可见的技能：内置恒在，用户技能只取启用的。
 * 只查名称与描述 —— 正文要等模型主动 read_skill 才进上下文。
 */
export async function listAvailableSkills(actorId: string): Promise<SkillSummary[]> {
  const rows = await db
    .select({
      name: skills.name,
      description: skills.description,
      source: skills.source,
      origin: skills.origin,
    })
    .from(skills)
    .where(and(eq(skills.userId, actorId), eq(skills.enabled, true)))
    .orderBy(asc(skills.createdAt));
  return [
    ...BUILTIN_SKILLS.map((s) => ({
      name: s.name,
      description: s.description,
      source: "builtin" as const,
      origin: "agilecampus" as const,
      enabled: true,
    })),
    ...rows.map((r) => ({
      name: r.name,
      description: r.description,
      source: r.source,
      origin: r.origin,
      enabled: true,
    })),
  ];
}

export type ResolvedSkill =
  | ({ kind: "builtin" } & BuiltinSkill)
  | ({ kind: "user"; id: string } & SkillRecord);

/** 按名称取可用的技能（内置 / 启用的用户技能），名称大小写不敏感 */
export async function resolveSkill(
  actorId: string,
  rawName: string,
): Promise<ResolvedSkill> {
  const name = normalizeSkillName(rawName);
  const lower = name.toLowerCase();
  const builtin = BUILTIN_SKILLS.find((s) => s.name.toLowerCase() === lower);
  if (builtin) return { kind: "builtin", ...builtin };

  // 名称匹配不区分大小写；用户技能通常只有几条，整表读回来再比即可
  const all = await db.select().from(skills).where(eq(skills.userId, actorId));
  const skill = all.find((r) => r.name.toLowerCase() === lower);
  if (!skill) {
    const available = await listAvailableSkills(actorId);
    throw new AppError(
      `没有叫「${name}」的技能。可用技能：${available.map((s) => s.name).join("、")}`,
    );
  }
  if (!skill.enabled) throw new AppError(`技能「${skill.name}」已停用，请先在 AI 配置页启用`);
  return { kind: "user", ...toRecord(skill) };
}

function toRecord(row: typeof skills.$inferSelect): SkillRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    files: Array.isArray(row.files) ? (row.files as SkillFile[]) : [],
    source: row.source,
    origin: row.origin,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
