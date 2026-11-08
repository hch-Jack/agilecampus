"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FilePreviewModal } from "@/components/file-preview";
import { formatShortDateTime } from "@/lib/time";
import { MAX_FILE_SIZE, MAX_FILE_SIZE_LABEL } from "@/lib/file-limits";
import { uploadFileRaw } from "@/lib/upload-client";
// 类型从 lib 走 import type（编译期擦除），服务端依赖不进浏览器包
import type { AttachmentCenterFile, AttachmentCenterTask } from "@/lib/attachment";
import { deleteAttachmentAction, type FormState } from "../tasks/[taskId]/actions";

const STATUS_LABEL: Record<AttachmentCenterTask["status"], string> = {
  todo: "待办",
  doing: "进行中",
  done: "已完成",
};

const STATUS_CLS: Record<AttachmentCenterTask["status"], string> = {
  todo: "bg-sunken text-ink-soft",
  doing: "bg-doing/10 text-doing",
  done: "bg-done/10 text-done",
};

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function AttachmentCenter({
  projectId,
  canWrite,
  timeZone,
  tasks,
}: {
  projectId: string;
  canWrite: boolean;
  timeZone: string;
  tasks: AttachmentCenterTask[];
}) {
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");

  if (tasks.length === 0) {
    return (
      <p className="ac-card p-5 text-sm text-ink-faint">
        项目还没有任务，创建任务后即可在这里上传和查看文件。
      </p>
    );
  }

  const totalFiles = tasks.reduce((n, t) => n + t.attachments.length, 0);

  return (
    <div className="space-y-4">
      {canWrite && (
        <UploadCard
          projectId={projectId}
          tasks={tasks}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
        />
      )}

      <p className="text-xs text-ink-faint">
        共 {tasks.length} 个任务 · {totalFiles} 个文件
      </p>

      <TaskTree
        projectId={projectId}
        canWrite={canWrite}
        timeZone={timeZone}
        tasks={tasks}
        depth={0}
      />
    </div>
  );
}

/** 顶层渲染 + 子任务缩进嵌套（parentId → children 一次建索引） */
function TaskTree(props: {
  projectId: string;
  canWrite: boolean;
  timeZone: string;
  tasks: AttachmentCenterTask[];
  depth: number;
}) {
  const { tasks, depth, ...rest } = props;
  const childrenOf = new Map<string, AttachmentCenterTask[]>();
  const roots: AttachmentCenterTask[] = [];
  for (const t of tasks) {
    if (t.parentTaskId) {
      const list = childrenOf.get(t.parentTaskId);
      if (list) list.push(t);
      else childrenOf.set(t.parentTaskId, [t]);
    } else {
      roots.push(t);
    }
  }
  // 父任务被筛掉/异常时子任务别凭空消失：挂回顶层渲染
  const orphanDepth = depth > 0 ? depth : 0;

  return (
    <>
      {roots.map((task) => (
        <TaskGroup
          key={task.id}
          {...rest}
          task={task}
          depth={orphanDepth}
          subtasks={childrenOf.get(task.id) ?? []}
          childrenOf={childrenOf}
        />
      ))}
    </>
  );
}

function TaskGroup({
  projectId,
  canWrite,
  timeZone,
  task,
  depth,
  subtasks,
  childrenOf,
}: {
  projectId: string;
  canWrite: boolean;
  timeZone: string;
  task: AttachmentCenterTask;
  depth: number;
  subtasks: AttachmentCenterTask[];
  childrenOf: Map<string, AttachmentCenterTask[]>;
}) {
  const creatorFiles = task.creatorId
    ? task.attachments.filter((f) => f.uploaderId === task.creatorId)
    : [];
  const memberFiles = task.creatorId
    ? task.attachments.filter((f) => f.uploaderId !== task.creatorId)
    : task.attachments;

  return (
    <>
      <section
        className="ac-card p-5"
        style={depth > 0 ? { marginLeft: depth * 20 } : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          {depth > 0 && <span className="text-ink-faint">└</span>}
          <Link
            href={`/projects/${projectId}/tasks/${task.id}`}
            className="min-w-0 truncate font-medium text-ink hover:text-primary"
            title={task.title}
          >
            {task.title}
          </Link>
          <span className={`ac-badge ${STATUS_CLS[task.status]}`}>
            {STATUS_LABEL[task.status]}
          </span>
          <span className="ml-auto text-xs text-ink-faint">
            共 {task.attachments.length} 个文件
          </span>
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          {task.assigneeName ? `负责人：${task.assigneeName}` : "未分配负责人"}
          {task.creatorName ? ` · 任务分配者：${task.creatorName}` : ""}
        </p>

        {task.attachments.length === 0 ? (
          <p className="mt-3 text-sm text-ink-faint">
            暂无附件
            {canWrite ? `，可在顶部选择此任务上传（单文件不超过 ${MAX_FILE_SIZE_LABEL}）` : ""}
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {creatorFiles.length > 0 && (
              <FileSection
                label="任务分配者提供的文件"
                hint={task.creatorName ? `由分配者 ${task.creatorName} 上传` : undefined}
                files={creatorFiles}
                projectId={projectId}
                taskId={task.id}
                canWrite={canWrite}
                timeZone={timeZone}
              />
            )}
            {memberFiles.length > 0 && (
              <FileSection
                label="成员上传的文件"
                files={memberFiles}
                projectId={projectId}
                taskId={task.id}
                canWrite={canWrite}
                timeZone={timeZone}
              />
            )}
          </div>
        )}
      </section>

      {subtasks.map((sub) => (
        <TaskGroup
          key={sub.id}
          projectId={projectId}
          canWrite={canWrite}
          timeZone={timeZone}
          task={sub}
          depth={depth + 1}
          subtasks={childrenOf.get(sub.id) ?? []}
          childrenOf={childrenOf}
        />
      ))}
    </>
  );
}

function FileSection({
  label,
  hint,
  files,
  projectId,
  taskId,
  canWrite,
  timeZone,
}: {
  label: string;
  hint?: string;
  files: AttachmentCenterFile[];
  projectId: string;
  taskId: string;
  canWrite: boolean;
  timeZone: string;
}) {
  return (
    <div>
      <p className="text-xs font-medium text-ink-soft">
        {label}
        {hint && <span className="ml-1 font-normal text-ink-faint">（{hint}）</span>}
      </p>
      <ul className="mt-1 space-y-1">
        {files.map((f) => (
          <FileRow
            key={f.id}
            projectId={projectId}
            taskId={taskId}
            file={f}
            canWrite={canWrite}
            timeZone={timeZone}
          />
        ))}
      </ul>
    </div>
  );
}

function FileRow({
  projectId,
  taskId,
  file,
  canWrite,
  timeZone,
}: {
  projectId: string;
  taskId: string;
  file: AttachmentCenterFile;
  canWrite: boolean;
  timeZone: string;
}) {
  const [deleteState, deleteAction, deleting] = useActionState<FormState, FormData>(
    deleteAttachmentAction,
    null,
  );
  const [previewing, setPreviewing] = useState(false);

  return (
    <li className="flex items-center gap-2 rounded px-1 py-1 hover:bg-sunken">
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm text-ink">{file.filename}</span>
        <span className="block truncate text-xs text-ink-faint">
          {fmtSize(file.size)} · {file.uploaderName ?? "未知用户"} ·{" "}
          {formatShortDateTime(timeZone, file.createdAt)}
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

      {/* 下载走 GET 路由（always attachment 响应），与 server action 写路径分离 */}
      <a
        href={`/api/attachments/${file.id}`}
        download={file.filename}
        className="text-xs text-primary underline"
      >
        下载
      </a>

      {canWrite && (
        <form
          action={deleteAction}
          onSubmit={(e) => {
            if (!confirm(`确认删除附件「${file.filename}」？此操作不可恢复。`))
              e.preventDefault();
          }}
        >
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="attachmentId" value={file.id} />
          <button disabled={deleting} className="text-xs text-high underline disabled:opacity-50">
            删除
          </button>
        </form>
      )}

      {deleteState?.error && <p className="text-xs text-high">{deleteState.error}</p>}

      {previewing && (
        <FilePreviewModal
          file={{
            url: `/api/attachments/${file.id}`,
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
          }}
          onClose={() => setPreviewing(false)}
        />
      )}
    </li>
  );
}

function UploadCard({
  projectId,
  tasks,
  selectedTaskId,
  onSelectTask,
}: {
  projectId: string;
  tasks: AttachmentCenterTask[];
  selectedTaskId: string;
  onSelectTask: (id: string) => void;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  // 深度缩进用全角空格：下拉里能看出层级
  const depthOf = new Map<string, number>();
  for (const t of tasks) {
    const parentDepth = t.parentTaskId ? (depthOf.get(t.parentTaskId) ?? 0) : -1;
    depthOf.set(t.id, parentDepth + 1);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const taskId = selectedTaskId || tasks[0]?.id;
    const file = inputRef.current?.files?.[0];
    if (!taskId) {
      setError("请选择要上传到的任务");
      return;
    }
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
    <form onSubmit={submit} className="ac-card space-y-2 p-5">
      <p className="text-sm font-medium text-ink">上传文件</p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedTaskId}
          onChange={(e) => onSelectTask(e.target.value)}
          className="ac-field min-w-0 flex-1 text-sm"
          aria-label="选择任务"
        >
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {"\u00A0".repeat((depthOf.get(t.id) ?? 0) * 2)}
              {t.title}
            </option>
          ))}
        </select>
        <input
          ref={inputRef}
          type="file"
          required
          className="ac-field min-w-0 flex-1 text-sm file:mr-2 file:rounded-field file:border-0 file:bg-sunken file:px-2 file:py-1 file:text-xs file:text-ink"
        />
        <button disabled={pending} className="ac-btn">
          {pending ? "上传中…" : "上传到所选任务"}
        </button>
      </div>
      <p className="text-xs text-ink-faint">
        文件会挂到所选任务上，任务分配者上传的会归入「任务分配者提供的文件」。单文件不超过{" "}
        {MAX_FILE_SIZE_LABEL}。
      </p>
      {error && <p className="text-sm text-high">{error}</p>}
    </form>
  );
}
