import type { TeamRole, UserIdentity } from "@/db/schema";

// 身份与角色两枚小徽章。原先这两处标签各自散落在页面里（导航栏一个内联三元、
// 团队列表一个本地 RoleBadge），成员页要用时就成了第三份拷贝，故归拢到这里。

export const IDENTITY_LABEL: Record<UserIdentity, string> = {
  teacher: "导师",
  student: "学生",
};

/**
 * 身份徽章 —— 注册时填的身份。样式复用 globals.css 里的 .ac-identity-* 一套。
 *
 * 身份为空时（存量用户、飞书自动建号 `findOrCreateByFeishu` 都不写 identity）
 * 退回按**团队角色**显示导师/学生：否则一个当年被管理员设成导师的存量用户，
 * 在名单上会和成员长得一模一样，看不出区别。角色是 admin 时不给回退值 ——
 * 管理员另有 RoleBadge 标，两枚徽章不重复。
 *
 * className 用于透传响应式类（导航栏那枚是 `hidden sm:inline-flex`）。
 */
export function IdentityBadge({
  identity,
  role,
  className = "",
}: {
  identity: UserIdentity | null;
  role?: TeamRole;
  className?: string;
}) {
  const shown: UserIdentity | null =
    identity ?? (role === "teacher" ? "teacher" : role === "student" ? "student" : null);
  if (!shown) return null;

  const tone = shown === "teacher" ? "ac-identity-teacher" : "ac-identity-student";
  return <span className={`ac-identity-badge ${tone} ${className}`}>{IDENTITY_LABEL[shown]}</span>;
}

export const ROLE_LABEL: Record<TeamRole, string> = {
  admin: "管理员",
  teacher: "导师",
  student: "成员",
};

/** 角色徽章 —— 「我在/TA 在这个团队里是什么」。与身份分开：建团者是 admin，与注册身份无关。 */
export function RoleBadge({ role }: { role: TeamRole }) {
  const cls =
    role === "admin"
      ? "bg-primary-soft text-primary"
      : role === "teacher"
        ? "bg-accent-soft text-accent"
        : "bg-low-soft text-low";
  return <span className={`ac-badge ${cls}`}>{ROLE_LABEL[role]}</span>;
}
