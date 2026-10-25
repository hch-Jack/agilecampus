"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { submitCompletionAction } from "@/app/(app)/projects/[projectId]/actions";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 附件个数上限（与 submitCompletionAction 服务端口径一致） */
const MAX_FILES = 5;

/**
 * 完成申请弹窗（两步）：确认「要提交吗」→ 填完成情况 + 选附件。
 * 学生看板/项目看板把任务拖到「已完成」时打开；提交走 submitCompletionAction
 * （附件先传、再标 done——学生被审批流拦截即视为申请已受理）。
 */
export function CompletionRequestModal({
  taskId,
  projectId,
  taskTitle,
  onClose,
}: {
  taskId: string;
  projectId: string;
  taskTitle: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"confirm" | "form">("confirm");
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const f of list) {
        if (next.length >= MAX_FILES) break;
        if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
      }
      return next;
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function submit() {
    if (!note.trim()) {
      setError("请填写完成情况");
      return;
    }
    startTransition(async () => {
      setError("");
      const fd = new FormData();
      fd.set("taskId", taskId);
      fd.set("projectId", projectId);
      fd.set("completionNote", note.trim());
      for (const f of files) fd.append("files", f);
      const res = await submitCompletionAction(fd);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // 审批申请已受理（或管理员直接完成）：整页回流带出角标/动态/消息
      onClose();
      router.refresh();
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="提交完成申请"
    >
      <div
        className="w-full max-w-lg rounded-field border border-line bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {step === "confirm" ? (
          <div className="p-5">
            <h2 className="font-display text-base font-semibold text-ink">完成任务需要审批</h2>
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">
              「{taskTitle}」标记为已完成需要<strong className="text-ink">老师或管理员审批</strong>
              。要提交完成申请吗？提交后可在下一步填写完成情况并附上资料。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="ac-btn-ghost px-3 py-1.5 text-sm">
                取消
              </button>
              <button
                type="button"
                onClick={() => setStep("form")}
                className="ac-btn px-3 py-1.5 text-sm"
              >
                要，填写完成情况
              </button>
            </div>
          </div>
        ) : (
          <div className="p-5">
            <h2 className="font-display text-base font-semibold text-ink">
              提交完成申请<span className="ml-1.5 text-xs font-normal text-ink-faint">{taskTitle}</span>
            </h2>

            <label className="mt-3 block space-y-1">
              <span className="text-xs font-medium text-ink-soft">
                完成情况<span className="text-high">（必填，会写入任务的完成情况栏）</span>
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={4}
                maxLength={2000}
                placeholder="做了什么、结果如何、有什么产出……"
                className="w-full resize-none rounded-field border border-line-strong bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
                aria-label="完成情况说明"
              />
            </label>

            <div className="mt-3">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-ink-soft">完成资料附件（可选，≤10MB/个）</span>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={files.length >= MAX_FILES}
                  className="ac-btn-ghost px-2 py-0.5 text-xs disabled:opacity-50"
                >
                  ＋ 添加附件
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => addFiles(e.target.files)}
                  aria-label="选择附件"
                />
              </div>
              {files.length > 0 && (
                <ul className="mt-1.5 space-y-1">
                  {files.map((f, i) => (
                    <li
                      key={`${f.name}-${f.size}-${i}`}
                      className="flex items-center gap-2 rounded-field bg-sunken px-2 py-1 text-xs text-ink-soft"
                    >
                      <span aria-hidden>📄</span>
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="shrink-0 text-ink-faint">{fmtSize(f.size)}</span>
                      <button
                        type="button"
                        onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                        className="text-ink-faint hover:text-high"
                        aria-label={`移除 ${f.name}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && <p className="mt-2 text-sm text-high">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={pending}
                className="ac-btn-ghost px-3 py-1.5 text-sm disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={pending || !note.trim()}
                className="ac-btn px-3 py-1.5 text-sm disabled:opacity-50"
              >
                {pending ? "提交中…" : "提交完成申请"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
