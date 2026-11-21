"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { grantEditor, revokeEditor, setCollaboration } from "@/lib/documents/service";

type ActionResult = { ok: true } | { error: string };

function messageOf(e: unknown): string {
  if (e instanceof AppError) return e.message;
  throw e;
}

export async function setCollaborationAction(
  documentId: string,
  enabled: boolean,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!z.uuid().safeParse(documentId).success || typeof enabled !== "boolean") {
    return { error: "参数不正确" };
  }
  try {
    await setCollaboration(documentId, session.user.id, enabled);
    revalidatePath(`/documents/${documentId}`);
    return { ok: true };
  } catch (e) {
    return { error: messageOf(e) };
  }
}

export async function grantEditorAction(
  documentId: string,
  userId: string,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!z.uuid().safeParse(documentId).success || !z.uuid().safeParse(userId).success) {
    return { error: "参数不正确" };
  }
  try {
    await grantEditor(documentId, session.user.id, userId);
    revalidatePath(`/documents/${documentId}`);
    return { ok: true };
  } catch (e) {
    return { error: messageOf(e) };
  }
}

export async function revokeEditorAction(
  documentId: string,
  userId: string,
): Promise<ActionResult> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };
  if (!z.uuid().safeParse(documentId).success || !z.uuid().safeParse(userId).success) {
    return { error: "参数不正确" };
  }
  try {
    await revokeEditor(documentId, session.user.id, userId);
    revalidatePath(`/documents/${documentId}`);
    return { ok: true };
  } catch (e) {
    return { error: messageOf(e) };
  }
}
