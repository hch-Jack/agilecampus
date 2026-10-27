"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { TimeZoneOption } from "@/lib/time";
import { deleteAccountAction, markTutorialSeenAction, signOutAction } from "./actions";
import { FeishuModal } from "./user-menu/feishu-modal";
import { ProfileModal } from "./user-menu/profile-modal";
import { TimezoneModal } from "./user-menu/timezone-modal";
import { TutorialModal } from "./user-menu/tutorial-modal";
import { ConfirmDangerDialog } from "@/components/confirm-danger-dialog";

type ModalKind = "profile" | "feishu" | "timezone" | "tutorial";

const MENU_ITEMS: { kind: ModalKind; label: string }[] = [
  { kind: "profile", label: "修改信息" },
  { kind: "feishu", label: "绑定飞书" },
  { kind: "timezone", label: "时区设置" },
  { kind: "tutorial", label: "新手教程" },
];

// 「已挂载」信号：服务端 false、客户端水合后 true。教程首次自动弹出的小窗要 portal
// 到 body，而 portal 无法在服务端渲染——靠它在 SSR 与水合首帧都不渲染，之后才弹出。
const subscribeNoop = () => () => {};

// 顶栏右上角「设置」菜单：齿轮按钮展开一列，外点或 Escape 收起；
// 前三个功能点开小窗口完成，「退出」直接登出。展开动画见 project.css 的 .ac-pop-in。
export function UserMenu({
  profile,
  feishu,
  timezone,
  tutorial,
}: {
  profile: {
    name: string;
    identity: "teacher" | "student" | null;
    feishuOnly: boolean;
    avatarUrl: string | null;
  };
  feishu: { boundName: string | null; boundAtLabel: string | null };
  timezone: { pref: string; options: TimeZoneOption[] };
  tutorial: { autoOpen: boolean };
}) {
  const [open, setOpen] = useState(false);
  // 教程自动弹出走 useState 初值而非 effect：初值来自服务端给的 props，effect 里同步
  // setState 会造成级联渲染（react-hooks/set-state-in-effect）。
  const [modal, setModal] = useState<ModalKind | null>(tutorial.autoOpen ? "tutorial" : null);
  // 注销账号确认弹窗：密码二次确认 + 提交中态。open 由菜单「注销账号」按钮触发。
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);
  const rootRef = useRef<HTMLDivElement>(null);

  // 首次登录弹出即标记已看过（幂等，见 actions）；中途关掉浏览器也不会下次再弹——
  // 回看走「设置 → 新手教程」。
  useEffect(() => {
    if (tutorial.autoOpen) markTutorialSeenAction().catch(() => {});
  }, [tutorial.autoOpen]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const openModal = (kind: ModalKind) => {
    setOpen(false);
    setModal(kind);
  };

  function closeDeleteDialog() {
    setDeleteOpen(false);
    setDeletePassword("");
    setDeleteError(null);
  }

  // 注销账号：密码校验由 server action 做；成功后账号已匿名化，调 signOutAction 登出回 /login。
  // 提交中禁关弹窗（onCancel 守门），避免取消时动作仍在飞、稍后仍被登出。
  async function handleConfirmDelete() {
    if (!deletePassword || deletePending) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      const res = await deleteAccountAction(deletePassword);
      if ("error" in res) {
        setDeletePending(false);
        setDeleteError(res.error);
        return;
      }
      // 账号已匿名化 → 登出回 /login（signOutAction 内部 redirect）
      await signOutAction();
    } catch {
      setDeletePending(false);
      setDeleteError("注销失败，请稍后再试");
    }
  }

  return (
    <>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="设置"
          title="设置"
          onClick={() => setOpen((v) => !v)}
          className="ac-btn-ghost grid h-10 w-10 place-items-center rounded-full p-0"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {open && (
          <div
            role="menu"
            className="ac-pop-in absolute right-0 top-full z-30 mt-2 w-40 overflow-hidden rounded-field border border-line bg-surface p-1 shadow-pop"
          >
            {MENU_ITEMS.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                onClick={() => openModal(item.kind)}
                className="block w-full rounded px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-sunken hover:text-primary"
              >
                {item.label}
              </button>
            ))}
            <div className="my-1 h-px bg-line" />
            <form action={signOutAction} onSubmit={() => setOpen(false)}>
              <button
                type="submit"
                role="menuitem"
                className="block w-full rounded px-3 py-2 text-left text-sm text-high transition-colors hover:bg-sunken"
              >
                退出登录
              </button>
            </form>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setDeletePassword("");
                setDeleteError(null);
                setDeleteOpen(true);
              }}
              className="block w-full rounded px-3 py-2 text-left text-sm text-high transition-colors hover:bg-sunken"
            >
              注销账号
            </button>
          </div>
        )}
      </div>

      {/* 小窗 portal 到 body：顶栏的 backdrop-filter 会把 fixed 后代限定在顶栏盒内 */}
      {modal === "profile" &&
        createPortal(
          <ProfileModal
            initialName={profile.name}
            initialIdentity={profile.identity}
            feishuOnly={profile.feishuOnly}
            initialAvatarUrl={profile.avatarUrl}
            onClose={() => setModal(null)}
          />,
          document.body,
        )}
      {modal === "feishu" &&
        createPortal(
          <FeishuModal
            boundName={feishu.boundName}
            boundAtLabel={feishu.boundAtLabel}
            onClose={() => setModal(null)}
          />,
          document.body,
        )}
      {modal === "timezone" &&
        createPortal(
          <TimezoneModal
            pref={timezone.pref}
            options={timezone.options}
            onClose={() => setModal(null)}
          />,
          document.body,
        )}
      {modal === "tutorial" && mounted &&
        createPortal(
          // firstRun 决定要不要显示「跳过」：从菜单重开时不需要
          <TutorialModal firstRun={tutorial.autoOpen} onClose={() => setModal(null)} />,
          document.body,
        )}

      {/* 注销账号确认：portal 到 body——顶栏 backdrop-filter 会把 fixed 后代裁进顶栏盒内 */}
      {deleteOpen &&
        createPortal(
          <ConfirmDangerDialog
            open={deleteOpen}
            title="注销账号"
            confirmLabel={deletePending ? "注销中…" : "确认注销"}
            confirmDisabled={!deletePassword || deletePending}
            onConfirm={handleConfirmDelete}
            onCancel={() => {
              if (!deletePending) closeDeleteDialog();
            }}
          >
            <p>注销后账号将无法登录，邮箱、用户名、飞书绑定与头像会被清除。</p>
            <p className="mt-2">
              你参与过的他人项目里的任务、附件与动态会保留，显示为「已注销用户」。此操作不可撤销。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleConfirmDelete();
              }}
              className="mt-3 space-y-1"
            >
              <label className="block space-y-1">
                <span className="text-xs font-medium text-ink-soft">输入当前密码以确认</span>
                <input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="ac-field text-sm"
                  placeholder="密码"
                  autoComplete="current-password"
                  autoFocus
                />
              </label>
            </form>
            {deleteError && <p className="mt-2 text-sm text-high">{deleteError}</p>}
          </ConfirmDangerDialog>,
          document.body,
        )}
    </>
  );
}
