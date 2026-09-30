"use client";

import { useActionState, useState } from "react";
import type { TeamContentCounts } from "@/lib/team";
import {
  leaveTeamAction,
  removeMemberAction,
  updateRoleAction,
  type FormState,
} from "./actions";

export function MemberRow({
  teamId,
  member,
  isAdmin,
  isSelf,
}: {
  teamId: string;
  member: { userId: string; name: string; email: string; role: string };
  isAdmin: boolean;
  isSelf: boolean;
}) {
  const [roleState, roleAction, savingRole] = useActionState<FormState, FormData>(
    updateRoleAction,
    null,
  );
  const [removeState, removeAction, removing] = useActionState<FormState, FormData>(
    removeMemberAction,
    null,
  );
  const error = roleState?.error ?? removeState?.error;

  return (
    <li className="ac-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-ink">
          {member.name} <span className="text-xs text-ink-soft">{member.email}</span>
        </span>
        {isAdmin && !isSelf ? (
          <span className="flex flex-wrap items-center justify-end gap-2">
            <form action={roleAction} className="flex items-center gap-2">
              <input type="hidden" name="teamId" value={teamId} />
              <input type="hidden" name="userId" value={member.userId} />
              {/* key=role：角色变更后强制重挂载，使 defaultValue 重新采纳（非受控 select 不更新已挂载节点） */}
              <select
                key={member.role}
                name="role"
                defaultValue={member.role}
                className="ac-field w-auto py-1 text-sm"
              >
                <option value="admin">admin</option>
                <option value="teacher">teacher</option>
                <option value="student">student</option>
              </select>
              <button disabled={savingRole} className="ac-btn px-2 py-1 text-xs">
                保存
              </button>
            </form>
            {/* 管理员不可移除（lib 层同此规则）。与其给一个按下去必然报错的按钮，不如说明白怎么走 */}
            {member.role === "admin" ? (
              <span className="text-xs text-ink-faint">管理员不可移除，请先改其角色</span>
            ) : (
              <form
                action={removeAction}
                onSubmit={(e) => {
                  const text =
                    `确认将「${member.name}」移出团队？\n\n` +
                    "TA 将失去本团队全部项目的访问权，可凭邀请码重新加入。";
                  if (!confirm(text)) e.preventDefault();
                }}
              >
                <input type="hidden" name="teamId" value={teamId} />
                <input type="hidden" name="userId" value={member.userId} />
                <button disabled={removing} className="text-xs text-high underline disabled:opacity-50">
                  移除
                </button>
              </form>
            )}
          </span>
        ) : (
          <span className="text-sm text-ink-soft">{member.role}</span>
        )}
      </div>
      {error && <p className="mt-1 text-sm text-high">{error}</p>}
    </li>
  );
}

/**
 * 退出团队。三种形态由服务端算好（成员页数据本就全在手，不必客户端推断）：
 *  · willDissolve —— 团里只剩自己，退出即解散
 *  · needsSuccessor —— 自己是唯一管理员且还有别人，必须先指定接任者
 *  · 其余 —— 普通退出
 */
export function LeaveTeamForm({
  teamId,
  teamName,
  willDissolve,
  needsSuccessor,
  candidates,
  counts,
}: {
  teamId: string;
  teamName: string;
  willDissolve: boolean;
  needsSuccessor: boolean;
  candidates: { userId: string; name: string }[];
  counts?: TeamContentCounts;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(leaveTeamAction, null);
  const [hint, setHint] = useState<string | null>(null);

  return (
    <form
      action={formAction}
      className="ac-card space-y-2 p-4"
      onSubmit={(e) => {
        setHint(null);

        if (needsSuccessor) {
          const select = e.currentTarget.elements.namedItem("successorUserId");
          const picked =
            select instanceof HTMLSelectElement ? select.selectedOptions[0]?.textContent : null;
          if (!picked) {
            // 拦在本地，省一次注定被服务端拒掉的往返
            e.preventDefault();
            setHint("请先选择一名接任的管理员。");
            return;
          }
          const text =
            `确认退出团队「${teamName}」？\n\n` +
            `你是该团队唯一的管理员，将把管理员移交给「${picked}」。`;
          if (!confirm(text)) e.preventDefault();
          return;
        }

        if (willDissolve) {
          const c = counts;
          const content = [
            c && c.projects > 0 && `${c.projects} 个项目`,
            c && c.milestones > 0 && `${c.milestones} 个里程碑`,
            c && c.tasks > 0 && `${c.tasks} 个任务`,
          ].filter((s): s is string => Boolean(s));
          const text = [
            `确认退出并解散团队「${teamName}」？`,
            "",
            "你是该团队唯一的成员，退出即解散。",
            content.length > 0
              ? `将永久删除 ${content.join("、")}，以及这些项目下的全部对话记录、标签与资源占用。`
              : "该团队名下还没有项目。",
            "此操作不可撤销。",
          ].join("\n");
          if (!confirm(text)) e.preventDefault();
          return;
        }

        if (!confirm(`确认退出团队「${teamName}」？\n\n退出后需重新凭邀请码加入。`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="teamId" value={teamId} />
      {/* 与页面上那个「退出并解散团队」的确认框配对：没渲染它就不带这个字段，
          服务端据此拒绝一次「顺手就把整个团队删了」的退出（见 lib/team.ts leaveTeam） */}
      {willDissolve && <input type="hidden" name="dissolveIfSole" value="1" />}
      <h2 className="font-medium text-ink">退出团队</h2>

      {needsSuccessor && (
        <label className="block space-y-1">
          <span className="text-xs font-medium text-ink-soft">
            你是唯一的管理员，退出前必须指定一名成员接任
          </span>
          <select name="successorUserId" defaultValue="" className="ac-field w-auto text-sm">
            <option value="">请选择接任者</option>
            {candidates.map((c) => (
              <option key={c.userId} value={c.userId}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <button disabled={pending} className="text-sm text-high underline disabled:opacity-50">
        {pending ? "处理中…" : willDissolve ? "退出并解散团队" : "退出团队"}
      </button>

      {hint && <p className="text-sm text-high">{hint}</p>}
      {state?.error && <p className="text-sm text-high">{state.error}</p>}
    </form>
  );
}
