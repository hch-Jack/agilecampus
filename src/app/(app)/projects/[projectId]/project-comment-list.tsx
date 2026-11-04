"use client";

import { useActionState } from "react";
import { formatShortDateTime } from "@/lib/time";
import { MentionPicker, type MentionMember } from "@/components/mention-picker";
import { addProjectCommentAction, deleteProjectCommentAction, type FormState } from "./actions";

// 与任务留言板（comment-list.tsx）同构，仅去掉 taskId、改调项目级 action。
// @ 提醒 + 私信通知（默认勾选）+ 已 @ 人名渲染，全部对齐任务留言板。
export type ProjectCommentRowData = {
  id: string;
  content: string;
  createdAt: Date;
  authorId: string;
  authorName: string | null;
  mentionedUserIds: string[];
};

export function ProjectCommentList({
  projectId,
  comments,
  currentUserId,
  canComment,
  timeZone,
  members,
}: {
  projectId: string;
  comments: ProjectCommentRowData[];
  currentUserId: string;
  canComment: boolean;
  timeZone: string;
  members: MentionMember[];
}) {
  const nameById = new Map(members.map((m) => [m.id, m.name]));

  return (
    <div>
      <h2 className="font-display text-lg font-semibold text-ink">
        项目留言板 <span className="text-sm font-normal text-ink-faint">（{comments.length}）</span>
      </h2>

      {comments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">
          暂无留言{canComment ? "，欢迎在下方发表讨论" : ""}
        </p>
      ) : (
        <ul className="mt-3 space-y-3">
          {comments.map((c) => (
            <ProjectCommentItem
              key={c.id}
              projectId={projectId}
              comment={c}
              currentUserId={currentUserId}
              timeZone={timeZone}
              nameById={nameById}
            />
          ))}
        </ul>
      )}

      {canComment && (
        <AddProjectCommentForm projectId={projectId} members={members} />
      )}
    </div>
  );
}

function ProjectCommentItem({
  projectId,
  comment,
  currentUserId,
  timeZone,
  nameById,
}: {
  projectId: string;
  comment: ProjectCommentRowData;
  currentUserId: string;
  timeZone: string;
  nameById: Map<string, string>;
}) {
  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(
    deleteProjectCommentAction,
    null,
  );
  const isAuthor = comment.authorId === currentUserId;
  const mentionNames = comment.mentionedUserIds
    .map((id) => nameById.get(id))
    .filter((n): n is string => Boolean(n));

  return (
    <li className="rounded border border-line bg-sunken p-3 text-sm">
      <div className="flex items-center justify-between text-xs text-ink-faint">
        <span className="font-medium text-ink">{comment.authorName ?? "未知用户"}</span>
        <span>{formatShortDateTime(timeZone, comment.createdAt)}</span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-ink">{comment.content}</p>

      {mentionNames.length > 0 && (
        <p className="mt-1 text-xs text-primary">@{mentionNames.join(" @")}</p>
      )}

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

function AddProjectCommentForm({
  projectId,
  members,
}: {
  projectId: string;
  members: MentionMember[];
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    addProjectCommentAction,
    null,
  );

  return (
    <form action={formAction} className="mt-4 space-y-2 border-t border-line pt-3">
      <input type="hidden" name="projectId" value={projectId} />
      <textarea
        name="content"
        required
        rows={2}
        placeholder="写下你的留言或讨论..."
        maxLength={2000}
        className="ac-field w-full text-sm"
      />
      {state?.error && <p className="text-xs text-high">{state.error}</p>}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <MentionPicker members={members} />
          <label
            className="flex items-center gap-1.5 text-sm text-ink-faint"
            title="不勾选时，仅发表留言，不会向被 @ 的人发私信通知"
          >
            <input
              type="checkbox"
              name="notify"
              defaultChecked
              className="accent-primary"
            />
            发私信通知
          </label>
        </div>
        <button disabled={pending} className="ac-btn px-3 py-1.5 text-sm">
          {pending ? "发送中…" : "发表留言"}
        </button>
      </div>
    </form>
  );
}
