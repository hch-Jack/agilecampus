"use client";

import { useActionState } from "react";
import { updatePasswordAction, type PasswordState } from "../actions";

export function PasswordForm({ feishuOnly }: { feishuOnly: boolean }) {
  const [state, formAction, pending] = useActionState<PasswordState, FormData>(
    updatePasswordAction,
    null,
  );

  return (
    <form action={formAction} className="ac-card space-y-3 p-5">
      <h2 className="font-display text-base font-semibold text-ink">修改密码</h2>
      {feishuOnly && (
        <p className="text-sm text-ink-soft">
          你的账号通过飞书登录创建，没有初始密码——直接设置新密码即可。
        </p>
      )}

      {!feishuOnly && (
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-soft">当前密码</span>
          <input
            type="password"
            name="currentPassword"
            autoComplete="current-password"
            className="ac-field text-sm"
          />
        </label>
      )}

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-soft">新密码</span>
        <input
          type="password"
          name="newPassword"
          autoComplete="new-password"
          minLength={8}
          maxLength={64}
          className="ac-field text-sm"
        />
      </label>

      {state && "ok" in state && <p className="text-sm text-done">密码已修改。</p>}
      {state && "error" in state && <p className="text-sm text-high">{state.error}</p>}

      <div>
        <button type="submit" disabled={pending} className="ac-btn text-sm">
          {pending ? "保存中…" : "保存"}
        </button>
      </div>
    </form>
  );
}
