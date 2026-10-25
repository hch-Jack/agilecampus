"use client";

import { useActionState, useRef, useState } from "react";
import type { TeamContentCounts } from "@/lib/team";
import type { TeamRole, UserIdentity } from "@/db/schema";
import { IdentityBadge, RoleBadge } from "@/components/badges";
import { ConfirmDangerDialog } from "@/components/confirm-danger-dialog";
import { leaveTeamAction, removeMemberAction, type FormState } from "./actions";

export function MemberRow({
  teamId,
  member,
  isAdmin,
  isSelf,
}: {
  teamId: string;
  member: {
    userId: string;
    name: string;
    email: string;
    role: TeamRole;
    identity: UserIdentity | null;
  };
  isAdmin: boolean;
  isSelf: boolean;
}) {
  const [removeState, removeAction, removing] = useActionState<FormState, FormData>(
    removeMemberAction,
    null,
  );

  return (
    <li className="ac-card p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink">
          {member.name}
          {/* 身份取自注册时填的那个；为空的存量用户在 IdentityBadge 里退回按角色显示 */}
          <IdentityBadge identity={member.identity} role={member.role} />
          {member.role === "admin" && <RoleBadge role="admin" />}
          <span className="text-xs text-ink-soft">{member.email}</span>
        </span>
        {isAdmin && !isSelf && (
          <span className="flex flex-wrap items-center justify-end gap-2">
            {/* 管理员不可被移除（lib 层同此规则）。改身份的权力已收回，
                故这里不再有「先降级再移除」那条路 —— 与其指一条走不通的路，不如直说 */}
            {member.role === "admin" ? (
              <span className="text-xs text-ink-faint">管理员不可被移除，只能自己退出</span>
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
        )}
      </div>
      {removeState?.error && <p className="mt-1 text-sm text-high">{removeState.error}</p>}
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
  const [dialog, setDialog] = useState<{
    open: boolean;
    type: "normal" | "willDissolve" | "needsSuccessor";
    successorName?: string;
  }>({ open: false, type: "normal" });
  const formRef = useRef<HTMLFormElement>(null);

  // 计算 willDissolve 场景的内容列表
  const dissolveContent = (() => {
    const c = counts;
    const content = [
      c && c.projects > 0 && `${c.projects} 个项目`,
      c && c.milestones > 0 && `${c.milestones} 个里程碑`,
      c && c.tasks > 0 && `${c.tasks} 个任务`,
    ].filter((s): s is string => Boolean(s));
    return content.length > 0
      ? `将永久删除 ${content.join("、")}，以及这些项目下的全部对话记录、标签与资源占用。`
      : "该团队名下还没有项目。";
  })();

  // 弹窗内容根据场景不同
  const dialogTitle = dialog.type === "willDissolve" ? "退出并解散团队" : "退出团队";
  const confirmLabel = dialog.type === "willDissolve" ? "确认退出并解散" : "确认退出";

  const dialogContent = (() => {
    if (dialog.type === "needsSuccessor") {
      return (
        <>
          <p className="font-medium text-ink">确认退出团队「{teamName}」？</p>
          <p className="mt-2">
            你是该团队唯一的管理员，将把管理员移交给「{dialog.successorName}」。
          </p>
        </>
      );
    }
    if (dialog.type === "willDissolve") {
      return (
        <>
          <p className="font-medium text-ink">确认退出并解散团队「{teamName}」？</p>
          <ul className="mt-2 space-y-1">
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-danger/60" />
              <span>你是该团队唯一的成员，退出即解散。</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-danger/60" />
              <span>{dissolveContent}</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-danger/60" />
              <span>此操作不可撤销。</span>
            </li>
          </ul>
        </>
      );
    }
    return (
      <>
        <p className="font-medium text-ink">确认退出团队「{teamName}」？</p>
        <p className="mt-2">退出后需重新凭邀请码加入。</p>
      </>
    );
  })();

  function handleClick() {
    setHint(null);

    if (needsSuccessor) {
      const form = formRef.current;
      if (!form) return;
      const select = form.elements.namedItem("successorUserId");
      const picked =
        select instanceof HTMLSelectElement ? select.selectedOptions[0]?.textContent ?? undefined : undefined;
      if (!picked) {
        setHint("请先选择一名接任的管理员。");
        return;
      }
      setDialog({ open: true, type: "needsSuccessor", successorName: picked });
      return;
    }

    if (willDissolve) {
      setDialog({ open: true, type: "willDissolve" });
      return;
    }

    setDialog({ open: true, type: "normal" });
  }

  return (
    <>
      <form ref={formRef} action={formAction} className="ac-card space-y-2 p-4">
        <input type="hidden" name="teamId" value={teamId} />
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

        <button
          type="button"
          disabled={pending}
          onClick={handleClick}
          className="inline-flex items-center gap-1.5 text-sm text-high underline disabled:opacity-50"
        >
          {/* log-out：门+箭头，传达「退出」语义 */}
          <svg
            className="h-4 w-4 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {pending ? "处理中…" : willDissolve ? "退出并解散团队" : "退出团队"}
        </button>

        {hint && <p className="text-sm text-high">{hint}</p>}
        {state?.error && <p className="text-sm text-high">{state.error}</p>}
      </form>

      <ConfirmDangerDialog
        open={dialog.open}
        title={dialogTitle}
        confirmLabel={confirmLabel}
        onConfirm={() => {
          setDialog((d) => ({ ...d, open: false }));
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setDialog((d) => ({ ...d, open: false }))}
      >
        {dialogContent}
      </ConfirmDangerDialog>
    </>
  );
}