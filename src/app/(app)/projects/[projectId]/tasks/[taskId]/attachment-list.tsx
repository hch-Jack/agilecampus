"use client";

import { useActionState } from "react";
import {
  uploadAttachmentAction,
  deleteAttachmentAction,
  type FormState,
} from "./actions";

export type AttachmentRowData = {
  id: string;
  filename: string;
  mimeType: string | null;
  size: number;
  createdAt: Date;
  uploaderName: string | null;
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function AttachmentList({
  projectId,
  taskId,
  attachments,
  canWrite,
}: {
  projectId: string;
  taskId: string;
  attachments: AttachmentRowData[];
  canWrite: boolean;
}) {
  return (
    <div>
      <h2 className="font-display text-lg font-semibold text-ink">
        附件 <span className="text-sm font-normal text-ink-faint">（{attachments.length}）</span>
      </h2>

      {attachments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">
          暂无附件{canWrite ? "，可在下方上传（单文件不超过 10MB）" : ""}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {attachments.map((a) => (
            <AttachmentRow
              key={a.id}
              projectId={projectId}
              taskId={taskId}
              attachment={a}
              canWrite={canWrite}
            />
          ))}
        </ul>
      )}

      {canWrite && <UploadForm projectId={projectId} taskId={taskId} />}
    </div>
  );
}

function AttachmentRow({
  projectId,
  taskId,
  attachment,
  canWrite,
}: {
  projectId: string;
  taskId: string;
  attachment: AttachmentRowData;
  canWrite: boolean;
}) {
  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(
    deleteAttachmentAction,
    null,
  );

  return (
    <li className="flex items-center gap-2 rounded px-1 py-1 hover:bg-sunken">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{attachment.filename}</span>
        <span className="block truncate text-xs text-ink-faint">
          {fmtSize(attachment.size)} · {attachment.uploaderName ?? "未知用户"} ·{" "}
          {fmtTime(attachment.createdAt)}
        </span>
      </div>

      {/* 下载走 GET 路由（always attachment 响应），与 server action 写路径分离 */}
      <a
        href={`/api/attachments/${attachment.id}`}
        download={attachment.filename}
        className="text-xs text-primary underline"
      >
        下载
      </a>

      {canWrite && (
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (!confirm(`确认删除附件「${attachment.filename}」？此操作不可恢复。`))
              e.preventDefault();
          }}
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="attachmentId" value={attachment.id} />
          <button disabled={deleting} className="text-xs text-high underline disabled:opacity-50">
            删除
          </button>
        </form>
      )}

      {deleteState?.error && <p className="text-xs text-high">{deleteState.error}</p>}
    </li>
  );
}

function UploadForm({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    uploadAttachmentAction,
    null,
  );

  return (
    <form
      action={formAction}
      className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3"
    >
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="taskId" value={taskId} />
      <input
        type="file"
        name="file"
        required
        className="ac-field min-w-0 flex-1 text-sm file:mr-2 file:rounded-field file:border-0 file:bg-sunken file:px-2 file:py-1 file:text-xs file:text-ink"
      />
      <button disabled={pending} className="ac-btn">
        {pending ? "上传中…" : "上传附件"}
      </button>
      {state?.error && <p className="w-full text-sm text-high">{state.error}</p>}
    </form>
  );
}
