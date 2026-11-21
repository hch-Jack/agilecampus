"use client";

// 视图页签：切换 / 新建 / 重命名 / 删除（项目共享，方案 D3）。
// 派生的内置默认视图（id=null）不可改名删除——首次编辑其配置即自动落库成持久视图。
import { useState } from "react";
import type { ProjectView } from "@/lib/database-views";
import { ConfirmDangerDialog } from "@/components/confirm-danger-dialog";
import { useTaskDatabase } from "./database-store";

const KIND_LABEL: Record<ProjectView["kind"], string> = {
  table: "表格",
  board: "看板",
  timeline: "时间线",
};

export function ViewTabs() {
  const store = useTaskDatabase();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ProjectView["kind"]>("table");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<ProjectView | null>(null);

  const activeKey = store.activeView ? store.viewKey(store.activeView) : "";
  const canWrite = store.canWrite;

  async function submitCreate() {
    const name = newName.trim();
    if (!name) return;
    const ok = await store.createView(newKind, name);
    if (ok) {
      setCreating(false);
      setNewName("");
    }
  }

  async function submitRename() {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return;
    const ok = await store.renameView(renaming, name);
    if (ok) setRenaming(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {store.views.map((v) => {
        const key = store.viewKey(v);
        const active = key === activeKey;
        return (
          <span key={key} className="inline-flex items-center">
            {renaming === v.id ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitRename();
                }}
                className="inline-flex items-center gap-1"
              >
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  className="ac-field w-28 px-1.5 py-0.5 text-xs"
                />
                <button type="submit" className="text-xs text-primary hover:underline">
                  保存
                </button>
                <button
                  type="button"
                  onClick={() => setRenaming(null)}
                  className="text-xs text-ink-faint hover:text-ink"
                >
                  取消
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => store.setActiveView(key)}
                className={`rounded-lg px-2.5 py-1 text-sm transition-colors ${
                  active
                    ? "bg-primary-soft font-medium text-primary"
                    : "text-ink-soft hover:bg-sunken hover:text-ink"
                }`}
              >
                {v.name}
                <span className="ml-1 text-[10px] text-ink-faint">{KIND_LABEL[v.kind]}</span>
              </button>
            )}
            {active && v.id && canWrite && renaming !== v.id && (
              <span className="ml-0.5 flex items-center">
                <button
                  type="button"
                  title="重命名视图"
                  onClick={() => {
                    setRenaming(v.id);
                    setRenameValue(v.name);
                  }}
                  className="px-0.5 text-xs text-ink-faint hover:text-primary"
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="删除视图"
                  onClick={() => setDeleting(v)}
                  className="px-0.5 text-xs text-ink-faint hover:text-high"
                >
                  ×
                </button>
              </span>
            )}
          </span>
        );
      })}

      {canWrite && !creating && (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="rounded-lg px-2 py-1 text-sm text-ink-faint hover:bg-sunken hover:text-primary"
          title="新建视图"
        >
          ＋
        </button>
      )}
      {creating && (
        <span className="inline-flex items-center gap-1 rounded-lg border border-line bg-surface px-1.5 py-1">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitCreate();
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="视图名称"
            className="ac-field w-24 px-1.5 py-0.5 text-xs"
          />
          <select
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as ProjectView["kind"])}
            className="ac-field w-auto px-1 py-0.5 text-xs"
          >
            <option value="table">表格</option>
            <option value="board">看板</option>
            <option value="timeline">时间线</option>
          </select>
          <button type="button" onClick={() => void submitCreate()} className="text-xs text-primary hover:underline">
            创建
          </button>
          <button
            type="button"
            onClick={() => setCreating(false)}
            className="text-xs text-ink-faint hover:text-ink"
          >
            取消
          </button>
        </span>
      )}

      <ConfirmDangerDialog
        open={deleting !== null}
        title={`删除视图「${deleting?.name ?? ""}」`}
        confirmLabel="删除"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const id = deleting?.id;
          setDeleting(null);
          if (id) void store.deleteView(id);
        }}
      >
        <p className="text-sm text-ink-soft">
          视图的筛选、排序与列配置将一并删除，对所有成员生效。任务数据不受影响。
        </p>
      </ConfirmDangerDialog>
    </div>
  );
}
