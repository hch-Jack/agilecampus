import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  personalContexts,
  teamMembers,
  type PersonalContextSource,
  type PersonalContextVisibility,
} from "@/db/schema";
import { getProjectForUser } from "@/lib/project";
import { listTeamMembers } from "@/lib/team";
import { AppError, ForbiddenError } from "@/lib/errors";

/**
 * 个人上下文：每人自记的一组背景，喂给 AI 助手。
 *
 * - `shared`（默认）：进**项目助手**的系统提示 —— 本项目团队所有人都能通过助手看到它。
 * - `private`：只进本人的控制台助手（工作台）。
 *
 * 本文件是所有读写的收口处：**userId 一律由调用方传 actorId**，绝不接受别处来的 userId
 * （AI 草案里若混入 `userId` 也在此丢弃）。
 */

export const CONTEXT_MAX_ITEMS = 50;
export const CONTEXT_MAX_LENGTH = 1000;
// 进提示词时的收紧口径（防注入 + 控 token）：单条截断、每人至多几条，见 agent/snapshot.ts
export const CONTEXT_PROMPT_PER_MEMBER = 5;
export const CONTEXT_PROMPT_ENTRY_LIMIT = 200;

export type PersonalContextItem = {
  id: string;
  content: string;
  visibility: PersonalContextVisibility;
  source: PersonalContextSource;
  createdAt: Date;
  updatedAt: Date;
};

// 控制字符（保留 \t 与换行）、零宽与方向控制字符、行分隔符、BOM —— 输入框里全看不见，
// 却是提示词注入与「看着是空条目」的常见载体，故落库前一并剔掉
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\uFEFF]/g;

/**
 * 归一化：CRLF 折成 LF、剔除控制字符（保留 `\t` 与换行）与零宽字符，再 trim。
 *
 * 统一在落库前做完，读端就不必再防。HTML 不在此列 —— React 渲染自带转义。
 */
export function normalizeContextContent(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").replace(INVISIBLE, "").trim();
}

function assertContent(content: string): string {
  const normalized = normalizeContextContent(content);
  if (!normalized) throw new AppError("上下文内容不能为空");
  if (normalized.length > CONTEXT_MAX_LENGTH)
    throw new AppError(`单条上下文最多 ${CONTEXT_MAX_LENGTH} 字`);
  return normalized;
}

export async function listMyPersonalContext(actorId: string): Promise<PersonalContextItem[]> {
  return db
    .select({
      id: personalContexts.id,
      content: personalContexts.content,
      visibility: personalContexts.visibility,
      source: personalContexts.source,
      createdAt: personalContexts.createdAt,
      updatedAt: personalContexts.updatedAt,
    })
    .from(personalContexts)
    .where(eq(personalContexts.userId, actorId))
    .orderBy(asc(personalContexts.createdAt));
}

export async function countMyPersonalContext(actorId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(personalContexts)
    .where(eq(personalContexts.userId, actorId));
  return row?.n ?? 0;
}

export type PersonalContextInput = {
  content: string;
  visibility?: PersonalContextVisibility;
  source?: PersonalContextSource;
};

/** 批量新增（手填一条与助手草案一批走同一个口子）。超配额整批拒绝，不留半截 */
export async function createPersonalContext(
  actorId: string,
  entries: PersonalContextInput[],
): Promise<number> {
  if (entries.length === 0) throw new AppError("没有要保存的上下文");
  const values = entries.map((e) => ({
    userId: actorId, // 恒为发话人：草案里混进来的 userId 在此被丢弃
    content: assertContent(e.content),
    visibility: e.visibility ?? "shared",
    source: e.source ?? "manual",
  }));

  const existing = await countMyPersonalContext(actorId);
  if (existing + values.length > CONTEXT_MAX_ITEMS)
    throw new AppError(`上下文最多 ${CONTEXT_MAX_ITEMS} 条，先删几条再记`);

  await db.insert(personalContexts).values(values);
  return values.length;
}

/**
 * 改可见性：只能改自己的 —— 查询里带 `userId = actorId`，改不到别人的行。
 * 时间戳取库钟（`sql\`now()\``，与 lib/task.ts 同口径），免得宿主与库时钟漂移。
 */
export async function setPersonalContextVisibility(
  actorId: string,
  id: string,
  visibility: PersonalContextVisibility,
): Promise<void> {
  const updated = await db
    .update(personalContexts)
    .set({ visibility, updatedAt: sql`now()` })
    .where(and(eq(personalContexts.id, id), eq(personalContexts.userId, actorId)))
    .returning({ id: personalContexts.id });
  if (updated.length === 0) throw new AppError("上下文不存在");
}

export async function deletePersonalContext(actorId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(personalContexts)
    .where(and(eq(personalContexts.id, id), eq(personalContexts.userId, actorId)))
    .returning({ id: personalContexts.id });
  if (deleted.length === 0) throw new AppError("上下文不存在");
}

export type MemberSharedContext = { userId: string; name: string; entries: string[] };

/**
 * 项目助手的「成员个人上下文」段：该项目所属团队成员的 **shared** 条目。
 *
 * 无项目级成员表（见图二备案：团队成员即可见全部团队项目），故「项目成员」= 团队成员。
 * **只取 shared**：private 条目永不出现在这里，也就永远不会进项目助手的系统提示。
 * 人名与顺序以 `listTeamMembers` 为准（无上下文的成员也返回，空数组即可）。
 */
export async function listProjectMembersSharedContext(
  actorId: string,
  projectId: string,
): Promise<MemberSharedContext[]> {
  const access = await getProjectForUser(actorId, projectId);
  if (!access) throw new ForbiddenError();
  const teamId = access.project.teamId;

  const [members, rows] = await Promise.all([
    listTeamMembers(teamId),
    db
      .select({ userId: personalContexts.userId, content: personalContexts.content })
      .from(personalContexts)
      .innerJoin(
        teamMembers,
        and(eq(teamMembers.userId, personalContexts.userId), eq(teamMembers.teamId, teamId)),
      )
      .where(eq(personalContexts.visibility, "shared"))
      .orderBy(asc(personalContexts.createdAt)),
  ]);

  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    const list = byUser.get(r.userId);
    if (list) list.push(r.content);
    else byUser.set(r.userId, [r.content]);
  }
  return members.map((m) => ({
    userId: m.id,
    name: m.name,
    entries: byUser.get(m.id) ?? [],
  }));
}
