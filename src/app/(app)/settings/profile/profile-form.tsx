"use client";

import { useActionState } from "react";
import { updateProfileAction, type ProfileState } from "../actions";

// 改用户名与身份。初始值由服务端页面给出；提交成功后页面重渲染（revalidatePath），
// 这里的 defaultValue 随之换成新值，无需本地状态同步。
export function ProfileForm({
  initialName,
  initialIdentity,
}: {
  initialName: string;
  initialIdentity: "teacher" | "student" | null;
}) {
  const [state, formAction, pending] = useActionState<ProfileState, FormData>(
    updateProfileAction,
    null,
  );

  return (
    <form action={formAction} className="ac-card space-y-3 p-5">
      <h2 className="font-display text-base font-semibold text-ink">用户名与身份</h2>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-soft">用户名</span>
        <input
          name="name"
          defaultValue={initialName}
          maxLength={24}
          className="ac-field text-sm"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-soft">身份</span>
        <select name="identity" defaultValue={initialIdentity ?? ""} className="ac-field text-sm">
          <option value="">未设置</option>
          <option value="teacher">导师</option>
          <option value="student">学生</option>
        </select>
      </label>

      {state && "ok" in state && <p className="text-sm text-done">已保存。</p>}
      {state && "error" in state && <p className="text-sm text-high">{state.error}</p>}

      <div>
        <button type="submit" disabled={pending} className="ac-btn text-sm">
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
