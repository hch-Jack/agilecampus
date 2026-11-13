"use client";

import { useState } from "react";
import type { DocumentVersionDto } from "./editor-types";

type Member = { userId: string; name: string | null; role: "admin" | "teacher" | "student" };

type Props = {
  initialTab?: "versions" | "permissions";
  canEdit: boolean;
  canManage: boolean;
  ownerUserId: string;
  collaborationEnabled: boolean;
  versions: DocumentVersionDto[];
  editors: { userId: string; name: string | null }[];
  members: Member[];
  currentUserId: string;
  busy: boolean;
  onToggleCollaboration: (enabled: boolean) => void;
  onGrant: (userId: string) => void;
  onRevoke: (userId: string) => void;
  onRestoreVersion: (version: number) => void;
  onClose: () => void;
};

const NOTE_LABEL: Record<string, string> = {
  initial: "原始版本",
  autosave: "自动保存",
  manual: "手动保存",
  restore: "恢复版本",
  save_as: "另存为",
};

const ROLE_LABEL: Record<Member["role"], string> = {
  admin: "管理员",
  teacher: "教师",
  student: "学生",
};

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function fmtSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 编辑器右侧栏：历史版本 + 文档级授权 + 协作开关。 */
export function EditorSidebar({
  initialTab = "versions",
  canEdit,
  canManage,
  ownerUserId,
  collaborationEnabled,
  versions,
  editors,
  members,
  currentUserId,
  busy,
  onToggleCollaboration,
  onGrant,
  onRevoke,
  onRestoreVersion,
  onClose,
}: Props) {
  const [tab, setTab] = useState<"versions" | "permissions">(initialTab);
  const editorIds = new Set(editors.map((e) => e.userId));
  const candidates = members.filter(
    (m) => m.userId !== ownerUserId && !editorIds.has(m.userId),
  );

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab("versions")}
            className={`ac-btn-ghost px-2 py-1 text-xs ${
              tab === "versions" ? "bg-surface-2 text-ink" : "text-ink-soft"
            }`}
          >
            历史版本
          </button>
          <button
            type="button"
            onClick={() => setTab("permissions")}
            className={`ac-btn-ghost px-2 py-1 text-xs ${
              tab === "permissions" ? "bg-surface-2 text-ink" : "text-ink-soft"
            }`}
          >
            权限
          </button>
        </div>
        <button type="button" className="ac-btn-ghost px-2 py-1 text-xs" onClick={onClose}>
          收起
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {tab === "versions" ? (
          <VersionList
            versions={versions}
            canEdit={canEdit}
            busy={busy}
            onRestore={onRestoreVersion}
          />
        ) : (
          <div className="space-y-4">
            <section>
              <h3 className="mb-1.5 text-xs font-medium text-ink-soft">协作编辑</h3>
              <label className="flex items-start gap-2 rounded border border-line p-2 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={collaborationEnabled}
                  disabled={!canManage || busy}
                  onChange={(e) => onToggleCollaboration(e.target.checked)}
                />
                <span className="text-ink-soft">
                  允许多人同时编辑
                  <span className="mt-1 block text-[11px] text-ink-faint">
                    关闭时同一时刻只有一人可编辑（单人锁）；开启后所有人可同时编辑，保存冲突时由你选择保留哪份。
                  </span>
                </span>
              </label>
              {!canManage && (
                <p className="mt-1 text-[11px] text-ink-faint">仅上传者或团队管理员可切换。</p>
              )}
            </section>

            <section>
              <h3 className="mb-1.5 text-xs font-medium text-ink-soft">编辑者</h3>
              <ul className="space-y-1.5">
                <li className="flex items-center justify-between rounded border border-line px-2 py-1.5 text-xs">
                  <span className="text-ink">
                    {members.find((m) => m.userId === ownerUserId)?.name ?? "上传者"}
                    {ownerUserId === currentUserId && "（我）"}
                  </span>
                  <span className="text-ink-faint">上传者 · 可管理</span>
                </li>
                {editors.map((e) => (
                  <li
                    key={e.userId}
                    className="flex items-center justify-between rounded border border-line px-2 py-1.5 text-xs"
                  >
                    <span className="text-ink">
                      {e.name ?? "成员"}
                      {e.userId === currentUserId && "（我）"}
                    </span>
                    {canManage ? (
                      <button
                        type="button"
                        className="ac-btn-ghost px-1.5 py-0.5 text-[11px] text-danger"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`撤销 ${e.name ?? "该成员"} 的编辑权限？`)) onRevoke(e.userId);
                        }}
                      >
                        撤销
                      </button>
                    ) : (
                      <span className="text-ink-faint">可编辑</span>
                    )}
                  </li>
                ))}
                {editors.length === 0 && (
                  <li className="text-[11px] text-ink-faint">尚未额外授权任何成员。</li>
                )}
              </ul>
            </section>

            {canManage && (
              <section>
                <h3 className="mb-1.5 text-xs font-medium text-ink-soft">添加编辑者</h3>
                {candidates.length === 0 ? (
                  <p className="text-[11px] text-ink-faint">团队内没有可授权的其他成员。</p>
                ) : (
                  <ul className="space-y-1">
                    {candidates.map((m) => (
                      <li
                        key={m.userId}
                        className="flex items-center justify-between rounded px-2 py-1 text-xs hover:bg-surface-2"
                      >
                        <span className="text-ink-soft">
                          {m.name ?? "成员"}
                          <span className="ml-1 text-[11px] text-ink-faint">
                            {ROLE_LABEL[m.role]}
                          </span>
                        </span>
                        <button
                          type="button"
                          className="ac-btn-ghost px-1.5 py-0.5 text-[11px]"
                          disabled={busy}
                          onClick={() => onGrant(m.userId)}
                        >
                          授权编辑
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[11px] text-ink-faint">
                  被授权者可编辑本文档；团队管理员与上传者始终可编辑。
                </p>
              </section>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function VersionList({
  versions,
  canEdit,
  busy,
  onRestore,
}: {
  versions: DocumentVersionDto[];
  canEdit: boolean;
  busy: boolean;
  onRestore: (version: number) => void;
}) {
  if (versions.length === 0) {
    return <p className="text-xs text-ink-faint">还没有保存记录。</p>;
  }
  return (
    <ol className="space-y-1.5">
      {versions.map((v) => (
        <li key={v.version} className="rounded border border-line px-2 py-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-ink">v{v.version}</span>
            <span className="text-[11px] text-ink-faint">
              {NOTE_LABEL[v.note ?? ""] ?? v.note ?? "保存"}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] text-ink-faint">
            {v.creatorName ?? "未知用户"} · {fmtSize(v.size)}
          </div>
          <div className="text-[11px] text-ink-faint">{fmtTime(v.createdAt)}</div>
          {canEdit && (
            <button
              type="button"
              className="ac-btn-ghost mt-1 px-1.5 py-0.5 text-[11px]"
              disabled={busy}
              onClick={() => {
                if (confirm(`恢复 v${v.version} 为当前内容？将生成一个新版本，历史不丢失。`)) {
                  onRestore(v.version);
                }
              }}
            >
              恢复此版本
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
