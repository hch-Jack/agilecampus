"use client";

import { useActionState, useRef, useState } from "react";
import { leaveTeamAction, type FormState } from "@/app/(app)/teams/[teamId]/members/actions";
import { ConfirmDangerDialog } from "@/components/confirm-danger-dialog";

export function ExitTeamForm({ teamId, teamName }: { teamId: string; teamName: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    leaveTeamAction,
    null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <>
      <form ref={formRef} action={formAction} className="flex flex-col items-end">
        <input type="hidden" name="teamId" value={teamId} />
        <button
          type="button"
          disabled={pending}
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium
                     text-high/80 transition-all
                     hover:text-high hover:bg-high/10
                     hover:scale-105
                     hover:shadow-[0_0_12px_rgba(182,72,47,0.35)]
                     hover:ring-1 hover:ring-high/30
                     disabled:opacity-50"
        >
          {/* log-out：门+箭头 → 退出 */}
          <svg
            className="h-4 w-4 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          {pending ? "退出中…" : "退出团队"}
        </button>
        {state?.error && <p className="mt-1 text-right text-sm text-high">{state.error}</p>}
      </form>

      <ConfirmDangerDialog
        open={dialogOpen}
        title="退出团队"
        confirmLabel="确认退出"
        onConfirm={() => {
          setDialogOpen(false);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setDialogOpen(false)}
      >
        <p className="font-medium text-ink">确认退出团队「{teamName}」？</p>
        <ul className="mt-2 space-y-1">
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-danger/60" />
            <span>退出后需重新凭邀请码加入。</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-danger/60" />
            <span>你将失去本团队全部项目的访问权。</span>
          </li>
        </ul>
      </ConfirmDangerDialog>
    </>
  );
}