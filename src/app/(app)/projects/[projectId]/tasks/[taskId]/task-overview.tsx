"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { updateTaskAction, type UpdateTaskState } from "../../actions";
import { deleteTaskFromDetailAction, type FormState } from "./actions";
import { LABEL_COLOR_CLASS } from "@/lib/board-columns";

export type TaskOverviewData = {
  id: string;
  title: string;
  description: string | null;
  completionNote: string | null;
  status: string;
  priority: string;
  startDate: string | null;
  dueDate: string | null;
  assigneeId: string | null;
  assigneeName: string | null;
  milestoneId: string | null;
  labels: { id: string; name: string; color: string }[];
};

// 任务的描述与属性两卡：只读展示 + 「编辑」就地切换为全字段编辑表单。
// 编辑功能自看板 EditModal 迁入（updateTaskAction 跨目录复用），详情页成为任务唯一编辑入口
export function TaskOverview({
  projectId,
  task,
  canWrite,
  milestoneTitle,
  successors,
  members,
  milestones,
  allLabels,
  allTasks,
}: {
  projectId: string;
  task: TaskOverviewData;
  canWrite: boolean;
  milestoneTitle: string | null;
  successors: { id: string; title: string }[];
  members: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
  allLabels: { id: string; name: string }[];
  allTasks: { id: string; title: string }[];
}) {
  const [editing, setEditing] = useState(false);
  const [deleteState, deleteFormAction, deleting] = useActionState<FormState, FormData>(
    deleteTaskFromDetailAction,
    null,
  );
  const deleteError = deleteState && "error" in deleteState ? deleteState.error : null;

  return (
    <>
      {/* 条件渲染而非 CSS 隐藏：退出再进编辑时 defaultValue 须取最新 props */}
      {editing ? (
        <EditTaskForm
          projectId={projectId}
          task={task}
          successors={successors}
          members={members}
          milestones={milestones}
          allLabels={allLabels}
          allTasks={allTasks}
          onDone={() => setEditing(false)}
        />
      ) : (
        <>
          <section className="ac-card space-y-4 p-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-medium text-ink-soft">描述</h2>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="text-xs text-ink-faint hover:text-primary hover:underline"
                  >
                    编辑
                  </button>
                )}
              </div>
              {task.description ? (
                <p className="whitespace-pre-wrap text-sm text-ink">{task.description}</p>
              ) : (
                <p className="text-sm text-ink-faint">暂无描述</p>
              )}
              {task.status === "done" && task.completionNote && (
                <p className="rounded bg-done/10 px-2 py-1 text-xs text-done">
                  完成情况：{task.completionNote}
                </p>
              )}
              {task.labels.length > 0 && (
                <p className="flex flex-wrap items-center gap-1">
                  {task.labels.map((l) => (
                    <span
                      key={l.id}
                      className={`ac-badge ${LABEL_COLOR_CLASS[l.color] ?? LABEL_COLOR_CLASS.slate}`}
                    >
                      {l.name}
                    </span>
                  ))}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4 border-t border-line pt-4 sm:grid-cols-3">
              <Prop label="负责人" value={task.assigneeName ?? "未分配"} />
              <Prop label="里程碑" value={milestoneTitle ?? "无里程碑"} />
              <Prop label="起始日" value={task.startDate ?? "—"} />
              <Prop label="截止日" value={task.dueDate ?? "—"} />
              <div className="col-span-2 sm:col-span-3">
                <h3 className="text-xs font-medium text-ink-soft">后置任务</h3>
                {successors.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-faint">无</p>
                ) : (
                  <ul className="mt-1 space-y-0.5">
                    {successors.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={`/projects/${projectId}/tasks/${s.id}`}
                          className="text-sm text-primary underline"
                        >
                          {s.title}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </section>
        </>
      )}

      {canWrite && (
        <form
          action={deleteFormAction}
          onSubmit={(e) => {
            if (!confirm("确认删除该任务？此操作不可恢复。")) e.preventDefault();
          }}
          className="flex items-center justify-end gap-3"
        >
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="projectId" value={projectId} />
          {deleteError && <p className="text-xs text-high">{deleteError}</p>}
          <button
            disabled={deleting}
            className="text-xs text-high underline disabled:opacity-50"
          >
            删除任务
          </button>
        </form>
      )}
    </>
  );
}

// 编辑表单独立成组件：useActionState 状态随卸载丢弃，重开即取最新 props；
// 保存成功经 onDone 回调退出编辑（照原 EditModal 的 onClose 先例）
function EditTaskForm({
  projectId,
  task,
  successors,
  members,
  milestones,
  allLabels,
  allTasks,
  onDone,
}: {
  projectId: string;
  task: TaskOverviewData;
  successors: { id: string; title: string }[];
  members: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
  allLabels: { id: string; name: string }[];
  allTasks: { id: string; title: string }[];
  onDone: () => void;
}) {
  const [updateState, updateFormAction, updating] = useActionState<UpdateTaskState, FormData>(
    updateTaskAction,
    null,
  );

  // 保存成功（action 回 { ok: true }）即退出编辑；revalidatePath 已让只读区拿到新数据
  useEffect(() => {
    if (updateState && "ok" in updateState) onDone();
  }, [updateState, onDone]);

  const updateError = updateState && "error" in updateState ? updateState.error : null;

  // 多选改用复选框组：原生 select multiple 须按住 Ctrl 点选，实际等于单选。
  // 勾选框按 name 聚合多值提交，与 getAll("labelIds"/"successorIds") 口径一致；
  // 全不勾 = 提交空数组，服务端即清空，语义与 select multiple 相同
  const labelIdSet = new Set(task.labels.map((l) => l.id));
  const successorIdSet = new Set(successors.map((s) => s.id));
  const successorCandidates = allTasks.filter((t) => t.id !== task.id);

  return (
    <section className="ac-card p-5">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold text-ink">编辑任务</h2>
        <button
          type="button"
          onClick={onDone}
          className="text-xs text-ink-faint hover:text-primary hover:underline"
        >
          取消编辑
        </button>
      </header>

      <form action={updateFormAction} className="space-y-2.5">
        <input type="hidden" name="taskId" value={task.id} />
        <input type="hidden" name="projectId" value={projectId} />

        <Field label="标题">
          <input name="title" defaultValue={task.title} className="ac-field text-sm" />
        </Field>
        <Field label="描述">
          <textarea
            name="description"
            defaultValue={task.description ?? ""}
            rows={3}
            className="ac-field text-sm"
            placeholder="任务描述"
          />
        </Field>
        <Field label="完成情况（完成时填写）">
          <textarea
            name="completionNote"
            defaultValue={task.completionNote ?? ""}
            rows={2}
            className="ac-field text-sm"
            placeholder="完成说明"
          />
        </Field>

        <div className="grid grid-cols-2 gap-2.5">
          <Field label="负责人">
            <select name="assigneeId" defaultValue={task.assigneeId ?? ""} className="ac-field text-sm">
              <option value="">未分配</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="里程碑">
            <select name="milestoneId" defaultValue={task.milestoneId ?? ""} className="ac-field text-sm">
              <option value="">无里程碑</option>
              {milestones.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="优先级">
            <select name="priority" defaultValue={task.priority} className="ac-field text-sm">
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
            </select>
          </Field>
          <Field label="起始日">
            <input type="date" name="startDate" defaultValue={task.startDate ?? ""} className="ac-field text-sm" />
          </Field>
          <Field label="截止日">
            <input type="date" name="dueDate" defaultValue={task.dueDate ?? ""} className="ac-field text-sm" />
          </Field>
        </div>

        {allLabels.length > 0 && (
          <Field label="标签（可多选）">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {allLabels.map((l) => (
                <label key={l.id} className="flex items-center gap-1.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="labelIds"
                    value={l.id}
                    defaultChecked={labelIdSet.has(l.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  {l.name}
                </label>
              ))}
            </div>
          </Field>
        )}

        <Field label="后置任务（可多选）">
          {successorCandidates.length === 0 ? (
            <p className="text-sm text-ink-faint">项目中暂无其他任务</p>
          ) : (
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">
              {successorCandidates.map((t) => (
                <label key={t.id} className="flex items-center gap-1.5 text-sm text-ink">
                  <input
                    type="checkbox"
                    name="successorIds"
                    value={t.id}
                    defaultChecked={successorIdSet.has(t.id)}
                    className="h-4 w-4 accent-primary"
                  />
                  {t.title}
                </label>
              ))}
            </div>
          )}
        </Field>

        {updateError && <p className="text-sm text-high">{updateError}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button type="button" onClick={onDone} className="ac-btn-ghost">
            取消
          </button>
          <button disabled={updating} className="ac-btn">
            {updating ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </section>
  );
}

function Prop({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-ink-soft">{label}</h3>
      <p className="mt-1 text-sm text-ink">{value}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-soft">{label}</span>
      {children}
    </label>
  );
}
