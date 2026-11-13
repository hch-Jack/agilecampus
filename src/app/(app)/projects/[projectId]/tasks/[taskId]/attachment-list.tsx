"use client";

import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FilePreviewModal } from "@/components/file-preview";
import { EditDocumentButton } from "@/components/documents/edit-document-button";
import { detectEditableFormat } from "@/lib/documents/format";
import { formatShortDateTime } from "@/lib/time";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { uploadFileRaw } from "@/lib/upload-client";
import { deleteAttachmentAction, type FormState } from "./actions";

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
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AttachmentList({
  projectId,
  taskId,
  attachments,
  canWrite,
  timeZone,
}: {
  projectId: string;
  taskId: string;
  attachments: AttachmentRowData[];
  canWrite: boolean;
  // 服务端算好的用户时区：客户端组件拿不到偏好，也不该自己去猜
  timeZone: string;
}) {
  return (
    <div>
      <h2 className="font-display text-lg font-semibold text-ink">
        附件 <span className="text-sm font-normal text-ink-faint">（{attachments.length}）</span>
      </h2>

      {attachments.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">
          暂无附件{canWrite ? `，可在下方上传（单文件不超过 ${MAX_FILE_SIZE_LABEL}）` : ""}
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
              timeZone={timeZone}
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
  timeZone,
}: {
  projectId: string;
  taskId: string;
  attachment: AttachmentRowData;
  canWrite: boolean;
  timeZone: string;
}) {
  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(
    deleteAttachmentAction,
    null,
  );
  const [previewing, setPreviewing] = useState(false);
  const editInfo = detectEditableFormat(attachment.filename, attachment.mimeType, attachment.size);

  return (
    <li className="flex items-center gap-2 rounded px-1 py-1 hover:bg-sunken">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{attachment.filename}</span>
        <span className="block truncate text-xs text-ink-faint">
          {fmtSize(attachment.size)} · {attachment.uploaderName ?? "未知用户"} ·{" "}
          {formatShortDateTime(timeZone, attachment.createdAt)}
        </span>
      </div>

      {/* 在线预览：图片/PDF/音视频/文本免下载查看，其余格式弹窗内提示下载 */}
      <button
        type="button"
        onClick={() => setPreviewing(true)}
        className="text-xs text-primary underline"
      >
        预览
      </button>

      {/* 在线编辑：仅对文本/Word/表格格式显示；其它格式预览弹窗内给出只读原因 */}
      {editInfo.editable && (
        <EditDocumentButton
          sourceType="task_attachment"
          sourceId={attachment.id}
          label="编辑"
          className="text-xs text-primary underline"
        />
      )}

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

      {previewing && (
        <FilePreviewModal
          file={{
            url: `/api/attachments/${attachment.id}`,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            size: attachment.size,
          }}
          onClose={() => setPreviewing(false)}
          edit={{ sourceType: "task_attachment", sourceId: attachment.id }}
        />
      )}
    </li>
  );
}

function UploadForm({ projectId, taskId }: { projectId: string; taskId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) {
      setError("请选择要上传的文件");
      return;
    }
    if (file.size === 0) {
      setError("不能上传空文件");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(`附件不能超过 ${MAX_FILE_SIZE_LABEL}`);
      return;
    }

    setPending(true);
    setError("");
    // 走 route handler 流式上传：server action 的 body 上限只有 12MB
    const res = await uploadFileRaw<{ id: string }>("/api/attachments/upload", file, {
      taskId,
      projectId,
    });
    setPending(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    if (inputRef.current) inputRef.current.value = "";
    router.refresh();
  }

  return (
    <form
      onSubmit={submit}
      className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3"
    >
      <input
        ref={inputRef}
        type="file"
        required
        className="ac-field min-w-0 flex-1 text-sm file:mr-2 file:rounded-field file:border-0 file:bg-sunken file:px-2 file:py-1 file:text-xs file:text-ink"
      />
      <button disabled={pending} className="ac-btn">
        {pending ? "上传中…" : "上传附件"}
      </button>
      {error && <p className="w-full text-sm text-high">{error}</p>}
    </form>
  );
}
