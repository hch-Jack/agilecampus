"use server";

import { z } from "zod";
import { auth } from "@/lib/auth";
import { saveDashboardLayout } from "@/lib/dashboard-layout-store";
import { parseLayoutPayload, type SaveLayoutResult } from "./layout-schema";
import {
  decideApproval,
  listMyApprovalHistory,
  type ApprovalDecision,
  type ApprovalHistoryRow,
} from "@/lib/approval";
import { DECISION_NOTE_MAX_LENGTH } from "@/lib/approval-view";
import { AppError } from "@/lib/errors";
import { revalidatePath } from "next/cache";

export type SaveDashboardLayoutResult = SaveLayoutResult;

/**
 * 保存当前用户的工作台布局（含缩放）。
 *
 * - 身份只从 session 取，绝不接受客户端传入的 userId；
 * - 校验口径与常驻栏共用 `parseLayoutPayload`，坐标/尺寸的最终裁决权在
 *   `normalizeLayoutDoc`（夹取、去重、碰撞消解）；
 * - **不 revalidate**：客户端正处在编辑态，整页回流会用服务端旧数据覆盖本地未保存的改动。
 */
export async function saveDashboardLayoutAction(payload: unknown): Promise<SaveDashboardLayoutResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = parseLayoutPayload(payload);
  if (!parsed.ok) return { error: parsed.error };

  await saveDashboardLayout(session.user.id, parsed.doc);
  return { ok: true };
}

// —— 待办审批卡片：通过 / 拒绝 ——

export type DecideApprovalResult = { ok: true } | { error: string };

const decideSchema = z.object({
  requestId: z.uuid(),
  decision: z.enum(["approved", "rejected"]),
  /** 拒绝原因（选填）：仅拒绝时生效，随系统消息回执发给申请人 */
  note: z.string().max(DECISION_NOTE_MAX_LENGTH).optional(),
});

/**
 * 审批人（老师/管理员任一）对一条申请给出决定。权限与状态校验在 lib/approval；
 * 成功后刷新工作台（卡片列表、未读角标随服务端回流）。
 */
export async function decideApprovalAction(
  input: unknown,
): Promise<DecideApprovalResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const parsed = decideSchema.safeParse(input);
  if (!parsed.success) return { error: "参数无效" };

  try {
    await decideApproval(
      session.user.id,
      parsed.data.requestId,
      parsed.data.decision as ApprovalDecision,
      parsed.data.note,
    );
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
  revalidatePath("/dashboard");
  return { ok: true };
}

// —— 任务看板「审批记录」弹窗 ——

export type ApprovalHistoryResult = { ok: true; data: ApprovalHistoryRow[] } | { error: string };

/** 与我有关的审批历史（我发起 + 我审批），打开弹窗时现拉一次 */
export async function listMyApprovalHistoryAction(): Promise<ApprovalHistoryResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  try {
    return { ok: true, data: await listMyApprovalHistory(session.user.id) };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}
