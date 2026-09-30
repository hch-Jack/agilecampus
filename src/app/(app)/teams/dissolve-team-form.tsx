"use client";

import { useActionState } from "react";
import type { TeamContentCounts } from "@/lib/team";
import { dissolveTeamAction, type FormState } from "./actions";

// 确认框里说清「按下去会失去什么」。计数从服务端随 props 下来——
// confirm() 跑在浏览器里，这里是唯一拿得到它们的地方。
// 硬删除不可逆，所以数量和「不可撤销」这两件事必须写进去，不能只说一句「确认解散？」。
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
  // members 含操作者自己，只有一个人时不必提
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

  // className 里的 w-full：让这一行独占一行（父级是 flex-wrap 的链接行），按钮再靠 ml-auto 右对齐。
  // 这样错误文案才有整行宽度可写 —— 若让 form 去 shrink-to-fit，长文案会被挤成一条窄柱。
  return (
    <form
      action={formAction}
      className="flex w-full flex-wrap items-center gap-2"
      onSubmit={(e) => {
        const text = [`确认解散团队「${teamName}」？`, "", ...impactLines(counts)].join("\n");
        if (!confirm(text)) e.preventDefault();
      }}
    >
      <input type="hidden" name="teamId" value={teamId} />
      <button disabled={pending} className="ml-auto text-xs text-high underline disabled:opacity-50">
        {pending ? "解散中…" : "解散团队"}
      </button>
      {state?.error && <p className="w-full text-right text-sm text-high">{state.error}</p>}
    </form>
  );
}
