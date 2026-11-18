"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import {
  createSkill,
  deleteSkill,
  setSkillEnabled,
  updateSkill,
} from "@/lib/skill";
import {
  parseSkillUpload,
  SKILL_UPLOAD_MAX_BYTES,
} from "@/lib/agent/skill-import";

/**
 * 「AI配置 → 技能」的服务端动作。
 *
 * 每个动作都在入口重新取 session（Server Action 可被直接 POST），
 * 所有读写都以 session.user.id 为 owner，表单里的 id 只能命中自己的技能。
 */

export type SkillState = { ok: true; message: string } | { error: string } | null;

function fail(e: unknown): { error: string } {
  if (e instanceof AppError) return { error: e.message };
  throw e;
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function uploadSkillAction(
  _prev: SkillState,
  formData: FormData,
): Promise<SkillState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const file = formData.get("skillFile");
  if (!(file instanceof File) || file.size === 0)
    return { error: "请选择要导入的技能文件（.zip / .md / .json）" };
  if (file.size > SKILL_UPLOAD_MAX_BYTES)
    return { error: "文件太大：技能包最大 2 MB" };

  try {
    const parsed = await parseSkillUpload(
      file.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    await createSkill(session.user.id, parsed, {
      source: "import",
      origin: parsed.origin,
    });
    revalidatePath("/settings");
    return {
      ok: true,
      message: `已导入技能「${parsed.name}」${
        parsed.files.length > 0 ? `（含 ${parsed.files.length} 个参考文件）` : ""
      }`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function createSkillAction(
  _prev: SkillState,
  formData: FormData,
): Promise<SkillState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  try {
    const skill = await createSkill(session.user.id, {
      name: field(formData, "name"),
      description: field(formData, "description"),
      instructions: field(formData, "instructions"),
    });
    revalidatePath("/settings");
    return { ok: true, message: `已创建技能「${skill.name}」` };
  } catch (e) {
    return fail(e);
  }
}

export async function updateSkillAction(
  _prev: SkillState,
  formData: FormData,
): Promise<SkillState> {
  const session = await auth();
  if (!session?.user) return { error: "请先登录" };

  const id = field(formData, "id");
  if (!id) return { error: "缺少技能 id" };

  try {
    const skill = await updateSkill(session.user.id, id, {
      name: field(formData, "name"),
      description: field(formData, "description"),
      instructions: field(formData, "instructions"),
    });
    revalidatePath("/settings");
    return { ok: true, message: `已保存「${skill.name}」` };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteSkillAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) return;
  const id = field(formData, "id");
  if (!id) return;
  try {
    await deleteSkill(session.user.id, id);
  } catch {
    // 已被删除 / 不属于本人：面板下次刷新自然消失，不必弹错
  }
  revalidatePath("/settings");
}

export async function toggleSkillAction(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) return;
  const id = field(formData, "id");
  const enabled = field(formData, "enabled") === "true";
  if (!id) return;
  try {
    await setSkillEnabled(session.user.id, id, enabled);
  } catch {
    // 同上
  }
  revalidatePath("/settings");
}
