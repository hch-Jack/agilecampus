"use client";

import { useActionState } from "react";
import { usePathname } from "next/navigation";
import {
  updatePasswordAction,
  updateProfileAction,
  type PasswordState,
  type ProfileState,
} from "../settings/actions";
import { Modal } from "./modal";

// 「修改信息」小窗：用户名与身份、修改密码两个表单。
// 初始值由顶栏布局（服务端）给出；提交成功后服务端按隐藏字段 from 重渲染当前页，
// defaultValue 随之换成新值，无需本地状态同步。
export function ProfileModal({
  initialName,
  initialIdentity,
  feishuOnly,
  onClose,
}: {
  initialName: string;
  initialIdentity: "teacher" | "student" | null;
  feishuOnly: boolean;
  onClose: () => void;
}) {
  const pathname = usePathname();
  const [profile, profileAction, profilePending] = useActionState<ProfileState, FormData>(
    updateProfileAction,
    null,
  );
  const [password, passwordAction, passwordPending] = useActionState<PasswordState, FormData>(
    updatePasswordAction,
    null,
  );

  return (
    <Modal title="修改信息" onClose={onClose}>
      <form action={profileAction} className="space-y-3 p-5">
        <input type="hidden" name="from" value={pathname} />

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
          <select
            name="identity"
            defaultValue={initialIdentity ?? ""}
            className="ac-field text-sm"
          >
            <option value="">未设置</option>
            <option value="teacher">导师</option>
            <option value="student">学生</option>
          </select>
        </label>

        {profile && "ok" in profile && <p className="text-sm text-done">已保存。</p>}
        {profile && "error" in profile && <p className="text-sm text-high">{profile.error}</p>}

        <div className="flex justify-end">
          <button type="submit" disabled={profilePending} className="ac-btn text-sm">
            {profilePending ? "保存中…" : "保存"}
          </button>
        </div>
      </form>

      <form action={passwordAction} className="space-y-3 border-t border-line p-5">
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

        {password && "ok" in password && <p className="text-sm text-done">密码已修改。</p>}
        {password && "error" in password && <p className="text-sm text-high">{password.error}</p>}

        <div className="flex justify-end">
          <button type="submit" disabled={passwordPending} className="ac-btn text-sm">
            {passwordPending ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
