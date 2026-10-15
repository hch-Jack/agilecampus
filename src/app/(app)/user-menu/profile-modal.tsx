"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  updatePasswordAction,
  updateProfileAction,
  uploadAvatarAction,
  type PasswordState,
  type ProfileState,
} from "../settings/actions";
import { Modal } from "./modal";

// 单文件上限与 lib/user.ts 的 AVATAR_MAX_SIZE 一致，客户端先拦一道省一次往返
const AVATAR_MAX_SIZE = 2 * 1024 * 1024;

// 「修改信息」小窗：头像上传、用户名与身份、修改密码三个表单。
// 初始值由顶栏布局（服务端）给出；提交成功后服务端按隐藏字段 from 重渲染当前页，
// defaultValue / initialAvatarUrl 随之换成新值，无需本地状态同步。
export function ProfileModal({
  initialName,
  initialIdentity,
  feishuOnly,
  initialAvatarUrl,
  onClose,
}: {
  initialName: string;
  initialIdentity: "teacher" | "student" | null;
  feishuOnly: boolean;
  initialAvatarUrl: string | null;
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

  // 只存「用户刚选、还没上传」的本地预览；真值永远是服务端给的 initialAvatarUrl。
  // 上传走直接调用（与私信发消息同款）：成功后当场清预览，revalidate 已把
  // initialAvatarUrl 换成新地址，预览自动落到服务端图，无需任何本地同步。
  const [picked, setPicked] = useState<{ file: File; url: string } | null>(null);
  const [pickError, setPickError] = useState("");
  const [avatarError, setAvatarError] = useState("");
  const [avatarSaved, setAvatarSaved] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // 换图 / 卸载时回收上一个 objectURL（预览只指向内存里的 blob）
  useEffect(
    () => () => {
      if (picked) URL.revokeObjectURL(picked.url);
    },
    [picked],
  );

  function pickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    if (!f) return;
    if (f.size > AVATAR_MAX_SIZE) {
      setPickError("图片不能超过 2MB");
      return;
    }
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
      setPickError("仅支持 PNG、JPEG、WebP 图片");
      return;
    }
    setPickError("");
    setPicked({ file: f, url: URL.createObjectURL(f) });
  }

  async function submitAvatar(e: React.FormEvent) {
    e.preventDefault();
    if (!picked || avatarUploading) return;
    setAvatarUploading(true);
    setAvatarError("");
    setAvatarSaved(false);
    const fd = new FormData();
    fd.set("from", pathname);
    fd.set("avatar", picked.file);
    const result = await uploadAvatarAction(null, fd).catch(
      (): { error: string } => ({ error: "网络异常，请稍后再试" }),
    );
    setAvatarUploading(false);
    if (!result || "error" in result) {
      setAvatarError(result?.error ?? "上传失败，请稍后再试");
      return;
    }
    setPicked(null);
    if (avatarInputRef.current) avatarInputRef.current.value = "";
    setAvatarSaved(true);
  }

  const previewUrl = picked?.url ?? initialAvatarUrl;

  return (
    <Modal title="修改信息" onClose={onClose}>
      <form onSubmit={submitAvatar} className="space-y-3 border-b border-line p-5">
        <div className="flex items-center gap-4">
          {previewUrl ? (
            // 有图显图；proj-avatar 类只在宇宙主题里有样式（描边光晕），头像沿用同一圈。
            // 头像是 <2MB 的本地小图且按版本号寻址长缓存，next/image 优化器帮不上忙。
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={previewUrl}
              alt=""
              className="proj-avatar h-14 w-14 shrink-0 rounded-full border border-line object-cover"
            />
          ) : (
            <span
              aria-hidden
              className="proj-avatar grid h-14 w-14 shrink-0 place-items-center rounded-full text-xl font-bold text-white"
            >
              {initialName.charAt(0) || "?"}
            </span>
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <p className="text-sm text-ink-soft">头像支持 PNG、JPEG、WebP，不超过 2MB。</p>
            <input
              ref={avatarInputRef}
              type="file"
              name="avatar"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={pickAvatar}
              aria-label="选择头像图片"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                disabled={avatarUploading}
                className="ac-btn-ghost text-sm"
              >
                选择图片
              </button>
              <button type="submit" disabled={!picked || avatarUploading} className="ac-btn text-sm">
                {avatarUploading ? "上传中…" : "上传头像"}
              </button>
            </div>
            {pickError && <p className="text-sm text-high">{pickError}</p>}
            {avatarSaved && <p className="text-sm text-done">头像已更新。</p>}
            {avatarError && <p className="text-sm text-high">{avatarError}</p>}
          </div>
        </div>
      </form>

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
