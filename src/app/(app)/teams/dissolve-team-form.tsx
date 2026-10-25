"use client";

import { useActionState, useRef, useState } from "react";
import type { TeamContentCounts } from "@/lib/team";
import { dissolveTeamAction, type FormState } from "./actions";
import { ConfirmDangerDialog } from "@/components/confirm-danger-dialog";

function impactLines(counts: TeamContentCounts): string[] {
  const content = [
    counts.projects > 0 && `${counts.projects} 个项目`,
    counts.milestones > 0 && `${counts.milestones} 个里程碑`,
    counts.tasks > 0 && `${counts.tasks} 个任务`,
  ].filter((s): s is string => Boolean(s));

  const lines = [
    content.length > 0
      ? `将永久删除 ${content.join("、")}，以及这些项目下的全部对话记录、标签与资源占用。`
      : "该团队名下还没有项目。",
  ];
  if (counts.members > 1) lines.push(`连同 ${counts.members} 名成员一并移出团队。`);
  lines.push("此操作不可撤销。");
  return lines;
}

export function DissolveTeamForm({
  teamId,
  teamName,
  counts,
}: {
  teamId: string;
  teamName: string;
  counts: TeamContentCounts;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    dissolveTeamAction,
    null,
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const lines = impactLines(counts);

  return (
    <>
      <form ref={formRef} action={formAction} className="flex flex-col items-end">
        <input type="hidden" name="teamId" value={teamId} />
        <button
          type="button"
          disabled={pending}
          onClick={() => setDialogOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium
                     text-danger/80 transition-all
                     hover:text-danger hover:bg-danger/10
                     hover:scale-105
                     hover:shadow-[0_0_12px_rgba(250,81,81,0.35)]
                     hover:ring-1 hover:ring-danger/30
                     disabled:opacity-50"
        >
          {/* users-x：两人 + X，传达「团队解散、成员散伙」的语义 */}
          <svg
            className="h-4 w-4 flex-shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <line x1="17" y1="8" x2="22" y2="13" />
            <line x1="22" y1="8" x2="17" y2="13" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          {pending ? "解散中…" : "解散团队"}
        </button>
        {state?.error && <p className="mt-1 text-right text-sm text-high">{state.error}</p>}
      </form>

      <ConfirmDangerDialog
        open={dialogOpen}
        title="解散团队"
        confirmLabel="确认解散"
        onConfirm={() => {
          setDialogOpen(false);
          formRef.current?.requestSubmit();
        }}
        onCancel={() => setDialogOpen(false)}
      >
        <p className="font-medium text-ink">确认解散团队「{teamName}」？</p>
        <ul className="mt-2 space-y-1">
          {lines.map((line, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-danger/60" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </ConfirmDangerDialog>
    </>
  );
}