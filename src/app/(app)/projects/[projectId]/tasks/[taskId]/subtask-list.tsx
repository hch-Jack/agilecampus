"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  toggleSubtaskDoneAction,
  addSubtaskAction,
  deleteSubtaskAction,
  type FormState,
} from "./actions";

// 状态徽章配色（软色 token 只有优先级有，状态用 /10 透明度，同完成情况块先例）。
// 导出供详情页 page.tsx 复用，保证两处徽章视觉一致。
export const STATUS_BADGE: Record<string, string> = {
  todo: "bg-todo/10 text-todo",
  doing: "bg-doing/10 text-doing",
  done: "bg-done/10 text-done",
};

export const STATUS_LABEL: Record<string, string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
};

export type SubtaskRowData = {
  id: string;
  title: string;
  status: string;
  priority: string;
  assigneeName: string | null;
  dueDate: string | null;
};

export function SubtaskList({
  projectId,
  taskId,
  subtasks,
  members,
  milestones,
  canWrite,
}: {
  projectId: string;
  taskId: string;
  subtasks: SubtaskRowData[];
  members: { id: string; name: string }[];
  milestones: { id: string; title: string }[];
  canWrite: boolean;
}) {
  const doneCount = subtasks.filter((s) => s.status === "done").length;

  return (
    <div>
      <h2 className="font-display text-lg font-semibold text-ink">
        子任务 <span className="text-sm font-normal text-ink-faint">（{doneCount}/{subtasks.length}）</span>
      </h2>

      {subtasks.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">
          暂无子任务{canWrite ? "，可在下方添加" : ""}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {subtasks.map((s) => (
            <SubtaskRow
              key={s.id}
              projectId={projectId}
              taskId={taskId}
              subtask={s}
              canWrite={canWrite}
            />
          ))}
        </ul>
      )}

      {canWrite && (
        <AddSubtaskForm
          projectId={projectId}
          taskId={taskId}
          members={members}
          milestones={milestones}
        />
      )}
    </div>
  );
}

function SubtaskRow({
  projectId,
  taskId,
  subtask,
  canWrite,
}: {
  projectId: string;
  taskId: string;
  subtask: SubtaskRowData;
  canWrite: boolean;
}) {
  const [toggleState, toggleAction, toggling] = useActionState<FormState, FormData>(
    toggleSubtaskDoneAction,
    null,
  );
  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(
    deleteSubtaskAction,
    null,
  );
  const done = subtask.status === "done";
  const error = toggleState?.error ?? deleteState?.error;

  return (
    <li
      className={`flex items-center gap-2 rounded px-1 py-1 ${canWrite ? "hover:bg-sunken" : ""}`}
    >
      {canWrite ? (
        // 每行独立表单：勾选变更即提交，未勾选时 done 字段缺省 → action 落回「待办」
        <form action={toggleAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="subtaskId" value={subtask.id} />
          <input
            type="checkbox"
            name="done"
            value="1"
            defaultChecked={done}
            disabled={toggling}
            aria-label={`完成子任务：${subtask.title}`}
            className="h-4 w-4 accent-primary"
            onChange={(e) => e.currentTarget.form?.requestSubmit()}
          />
        </form>
      ) : (
        <span className={`ac-badge ${STATUS_BADGE[subtask.status] ?? ""}`}>
          {STATUS_LABEL[subtask.status] ?? subtask.status}
        </span>
      )}

      {/* 除勾选框与删除钮外整行可点，跳该子任务自己的详情页 */}
      <Link
        href={`/projects/${projectId}/tasks/${subtask.id}`}
        className="min-w-0 flex-1 hover:opacity-80"
      >
        <span
          className={`block truncate text-sm ${done ? "text-ink-faint line-through" : "text-ink"}`}
        >
          {subtask.title}
        </span>
        <span className="block truncate text-xs text-ink-faint">
          {subtask.assigneeName ?? "未分配"}
          {subtask.dueDate ? ` · ${subtask.dueDate}` : ""}
        </span>
      </Link>

      {canWrite && (
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (!confirm("确认删除该子任务？")) e.preventDefault();
          }}
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="subtaskId" value={subtask.id} />
          <button disabled={deleting} className="text-xs text-high underline disabled:opacity-50">
            删除
          </button>
        </form>
      )}

      {error && <p className="text-xs text-high">{error}</p>}
    </li>
  );
}

function AddSubtaskForm({
  projectId,
  taskId,
  members,
  milestones,
}: {
  projectId: string;
  taskId: string;
  members: { id: string; name: string }[];
  milestones: { id: string; title: string }[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    addSubtaskAction,
    null,
  );

  return (
    <form action={formAction} className="mt-3 space-y-2 border-t border-line pt-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <div className="flex flex-wrap items-center gap-2">
        <input name="title" placeholder="子任务标题" className="ac-field min-w-40 flex-1 text-sm" />
        <select name="assigneeId" defaultValue="" className="ac-field w-28 text-sm">
          <option value="">未分配</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select name="milestoneId" defaultValue="" className="ac-field w-32 text-sm">
          <option value="">无里程碑</option>
          {milestones.map((m) => (
            <option key={m.id} value={m.id}>
              {m.title}
            </option>
          ))}
        </select>
        <select name="priority" defaultValue="medium" className="ac-field w-20 text-sm">
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </select>
        <input type="date" name="startDate" className="ac-field w-36 text-sm" />
        <input type="date" name="dueDate" className="ac-field w-36 text-sm" />
        <button disabled={pending} className="ac-btn">
          {pending ? "添加中…" : "添加子任务"}
        </button>
      </div>
      <textarea
        name="description"
        placeholder="子任务描述（可选）"
        rows={2}
        className="ac-field w-full text-sm"
      />
      {state?.error && <p className="text-sm text-high">{state.error}</p>}
    </form>
  );
}
