"use client";

import { useActionState } from "react";
import { createTaskAction, type FormState } from "./actions";

export function NewTaskForm({
  projectId,
  members,
  milestones,
  projectStart,
  projectEnd,
}: {
  projectId: string;
  members: { id: string; name: string }[];
  milestones: { id: string; title: string }[];
  projectStart?: string | null;
  projectEnd?: string | null;
}) {
  // 任务日期须落在项目周期内：原生 min/max 先行拦截，服务端 createTask 仍兜底
  const dateBounds = {
    min: projectStart ?? undefined,
    max: projectEnd ?? undefined,
  };
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createTaskAction,
    null,
  );

  return (
    <form action={formAction} className="ac-card space-y-2 p-4">
      <h2 className="font-medium text-ink">新建任务</h2>
      <input type="hidden" name="projectId" value={projectId} />
      <input name="title" placeholder="任务标题" className="ac-field" />
      <textarea name="description" placeholder="任务描述（可选）" rows={2} className="ac-field" />
      <div className="flex flex-wrap gap-2">
        <select name="assigneeId" defaultValue="" className="ac-field w-auto text-sm">
          <option value="">未分配</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select name="milestoneId" defaultValue="" className="ac-field w-auto text-sm">
          <option value="">无里程碑</option>
          {milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <select name="priority" defaultValue="medium" className="ac-field w-auto text-sm">
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-ink-faint">
          起
          <input type="date" name="startDate" {...dateBounds} className="ac-field w-auto text-sm" />
        </label>
        <label className="flex items-center gap-1 text-sm text-ink-faint">
          止
          <input type="date" name="dueDate" {...dateBounds} className="ac-field w-auto text-sm" />
        </label>
      </div>
      {state?.error && <p className="text-sm text-high">{state.error}</p>}
      <button disabled={pending} className="ac-btn px-3 py-2 text-sm">
        {pending ? "创建中…" : "创建任务"}
      </button>
    </form>
  );
}
