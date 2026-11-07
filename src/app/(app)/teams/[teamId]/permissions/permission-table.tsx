"use client";

import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { TeamRole, UserIdentity } from "@/db/schema";
import { IdentityBadge, RoleBadge } from "@/components/badges";
import { setMemberPermissionAction, type ToggleState } from "./actions";
import type { TeamPermission } from "@/lib/team-permissions";

export type PermissionMember = {
  userId: string;
  name: string;
  email: string;
  identity: UserIdentity | null;
  role: TeamRole;
  canApproveTaskDone: boolean;
  canApproveResource: boolean;
  canAcceptProject: boolean;
  /** 折算后的有效权限（admin 已是全有） */
  permissions: { taskDone: boolean; resource: boolean; project: boolean };
};

const COLUMNS: { key: TeamPermission; label: string }[] = [
  { key: "task_done", label: "审核任务完成申请" },
  { key: "resource", label: "审核资源占用" },
  { key: "project", label: "审核项目结题验收" },
];

// 权限短名（action 入参）→ 有效权限对象的键名
const PERM_KEY: Record<TeamPermission, "taskDone" | "resource" | "project"> = {
  task_done: "taskDone",
  resource: "resource",
  project: "project",
};

/**
 * 权限矩阵表：行 = 成员，列 = 三项审核权限。
 * 管理员行天然全有（勾选态、禁用）；其余行仅团队管理员可切换，
 * 点选即提交（乐观更新 + 整页回流），失败回弹并提示。
 */
export function PermissionTable({
  teamId,
  members,
  isAdmin,
  selfId,
}: {
  teamId: string;
  members: PermissionMember[];
  isAdmin: boolean;
  selfId: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // 勾选立刻可见，失败由 useOptimistic 自动回弹（refresh 落定新 props 时同样复位）
  const [rows, applyToggle] = useOptimistic(
    members,
    (current, toggle: { userId: string; perm: TeamPermission; value: boolean }) =>
      current.map((m) =>
        m.userId === toggle.userId
          ? { ...m, permissions: { ...m.permissions, [PERM_KEY[toggle.perm]]: toggle.value } }
          : m,
      ),
  );

  function toggle(m: PermissionMember, perm: TeamPermission, value: boolean) {
    if (m.role === "admin") return; // 管理员天然全有，点了也不提交
    startTransition(async () => {
      setError(null);
      applyToggle({ userId: m.userId, perm, value });
      const res: ToggleState = await setMemberPermissionAction({
        teamId,
        userId: m.userId,
        permission: perm,
        value,
      });
      if (res?.error) setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="ac-card p-0">
      {error && <p className="px-4 pt-3 text-sm text-high">{error}</p>}
      {/* 手机上三列表头超出屏宽，给一句滑动提示再交给横向滚动容器 */}
      <p className="px-4 pt-3 text-xs text-ink-faint sm:hidden">左右滑动表格可查看全部三项权限</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-soft">
              <th className="whitespace-nowrap px-4 py-3 font-medium">成员</th>
              {COLUMNS.map((c) => (
                // 窄屏下中文表头会被挤成一字一行；不换行，让外层 overflow-x-auto 横向滚
                <th key={c.key} className="whitespace-nowrap px-3 py-3 text-center font-medium">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const locked = m.role === "admin" || !isAdmin;
              return (
                <tr key={m.userId} className="border-b border-line last:border-b-0">
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-medium text-ink">
                        {m.name}
                        {m.userId === selfId && <span className="ml-1 text-xs text-ink-faint">（我）</span>}
                      </span>
                      <IdentityBadge identity={m.identity} role={m.role} />
                      {m.role === "admin" && <RoleBadge role="admin" />}
                    </span>
                    <span className="mt-0.5 block text-xs text-ink-faint">{m.email}</span>
                  </td>
                  {COLUMNS.map((c) => (
                    <td key={c.key} className="px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={m.permissions[PERM_KEY[c.key]]}
                        disabled={locked}
                        onChange={(e) => toggle(m, c.key, e.target.checked)}
                        aria-label={`${m.name} 的${c.label}权限`}
                        className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed max-sm:h-5 max-sm:w-5"
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!isAdmin && (
        <p className="px-4 py-3 text-xs text-ink-faint">仅团队管理员可调整权限，此处为只读视图。</p>
      )}
    </div>
  );
}
