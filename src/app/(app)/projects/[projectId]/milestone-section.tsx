"use client";

import { useActionState } from "react";
import { createMilestoneAction, type FormState } from "./actions";

type Milestone = {
  id: string;
  title: string;
  targetDate: string | null;
  status: string;
};

export function MilestoneSection({
  projectId,
  milestones,
  isAdmin,
}: {
  projectId: string;
  milestones: Milestone[];
  isAdmin: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createMilestoneAction,
    null,
  );

  return (
    <section className="space-y-2">
      <h2 className="font-medium text-ink">里程碑</h2>
      <ul className="flex flex-wrap gap-2">
        {milestones.map((m) => (
          <li key={m.id} className="ac-card px-3 py-1.5 text-sm text-ink">
            {m.title}
            {m.targetDate && (
              <span className="ml-1 text-xs text-ink-faint">{m.targetDate}</span>
            )}
            <span className="ml-1 text-xs text-ink-soft">[{m.status}]</span>
          </li>
        ))}
        {milestones.length === 0 && (
          <li className="text-sm text-ink-soft">暂无里程碑。</li>
        )}
      </ul>
      {isAdmin && (
        // 手机上三件套竖排：横排时「添加」会被挤成两行小方块
        <form
          action={formAction}
          className="flex flex-wrap items-end gap-2 max-sm:flex-col max-sm:items-stretch"
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input
            name="title"
            placeholder="里程碑标题"
            className="ac-field w-auto text-sm"
          />
          <input type="date" name="targetDate" className="ac-field w-auto text-sm" />
          <button disabled={pending} className="ac-btn shrink-0 whitespace-nowrap px-3 py-2 text-sm">
            添加
          </button>
          {state?.error && <p className="text-sm text-high">{state.error}</p>}
        </form>
      )}
    </section>
  );
}
