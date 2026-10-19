"use client";

import { useActionState } from "react";
import { formatShortDateTime } from "@/lib/time";
import { addCommentAction, deleteCommentAction, type FormState } from "./actions";

export type CommentRowData = {
  id: string;
  content: string;
  createdAt: Date;
  authorId: string;
  authorName: string | null;
};

export function CommentList({
  projectId,
  taskId,
  comments,
  currentUserId,
  canComment,
  timeZone,
}: {
  projectId: string;
  taskId: string;
  comments: CommentRowData[];
  currentUserId: string;
  canComment: boolean;
  timeZone: string;
}) {
  return (
    <div>
      <h2 className="font-display text-lg font-semibold text-ink">
        留言板 <span className="text-sm font-normal text-ink-faint">（{comments.length}）</span>
      </h2>

      {comments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">
          暂无留言{canComment ? "，欢迎在下方发表讨论" : ""}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              projectId={projectId}
              taskId={taskId}
              comment={c}
              currentUserId={currentUserId}
              timeZone={timeZone}
            />
          ))}
        </ul>
      )}

      {canComment && <AddCommentForm projectId={projectId} taskId={taskId} />}
    </div>
  );
}

function CommentItem({
  projectId,
  taskId,
  comment,
  currentUserId,
  timeZone,
}: {
  projectId: string;
  taskId: string;
  comment: CommentRowData;
  currentUserId: string;
  timeZone: string;
}) {
  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(
    deleteCommentAction,
    null,
  );
  const isAuthor = comment.authorId === currentUserId;

  return (
    <li className="rounded border border-line bg-sunken p-3 text-sm">
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span className="font-medium text-ink">{comment.authorName ?? "未知用户"}</span>
        <span>{formatShortDateTime(timeZone, comment.createdAt)}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-ink">{comment.content}</p>

      {deleteState?.error && <p className="mt-1 text-xs text-high">{deleteState.error}</p>}

      {isAuthor && (
        <div className="mt-2 flex justify-end">
          <form
            action={deleteAction}
            onSubmit={(e) => {
              if (!confirm("确认删除这条留言？")) e.preventDefault();
            }}
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="taskId" value={taskId} />
            <input type="hidden" name="commentId" value={comment.id} />
            <button
              disabled={deleting}
              className="text-xs text-high underline disabled:opacity-50"
            >
              删除
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

function AddCommentForm({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    addCommentAction,
    null,
  );

  return (
    <form action={formAction} className="mt-4 space-y-2 border-t border-line pt-3">
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <textarea
        name="content"
        required
        rows={2}
        placeholder="写下你的留言或讨论..."
        maxLength={2000}
        className="ac-field w-full text-sm"
      />
      {state?.error && <p className="text-xs text-high">{state.error}</p>}
      <div className="flex justify-end">
        <button disabled={pending} className="ac-btn px-3 py-1.5 text-sm">
          {pending ? "发送中…" : "发表留言"}
        </button>
      </div>
    </form>
  );
}
