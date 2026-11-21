"use client";

// 属性定义管理（PR2b）：表格工具行的「＋属性」新建入口 + 每个自定义列头的 ⋯ 菜单
// （改名 / 管理单选多选选项 / 上移下移 / 删除）。
// 类型创建后不可改（方案 D7）；单选选项 id 稳定，改名换色不影响已存的值。
import { useState } from "react";
import { LABEL_COLORS, LABEL_COLOR_CLASS } from "@/lib/board-columns";
import type { PropertyDef } from "@/lib/properties";
import { ConfirmDangerDialog } from "@/components/confirm-danger-dialog";
import { useTaskDatabase } from "./database-store";

const TYPE_LABEL: Record<PropertyDef["type"], string> = {
  text: "文本",
  number: "数字",
  select: "单选",
  multi_select: "多选",
  date: "日期",
  person: "人员",
  checkbox: "复选框",
};
const SELECT_TYPES = ["select", "multi_select"];
const COLOR_LABEL: Record<string, string> = {
  slate: "灰",
  red: "红",
  amber: "橙",
  green: "绿",
  blue: "蓝",
  violet: "紫",
  pink: "粉",
};

type OptionDraft = { id?: string; name: string; color: string };

function OptionRows({
  rows,
  onChange,
}: {
  rows: OptionDraft[];
  onChange(rows: OptionDraft[]): void;
}) {
  return (
    <div className="space-y-1">
      {rows.map((row, i) => (
        <div key={row.id ?? `new-${i}`} className="flex items-center gap-1">
          <input
            value={row.name}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)))
            }
            placeholder="选项名"
            className="ac-field min-w-0 flex-1 px-1.5 py-1 text-xs"
          />
          <select
            value={row.color}
            onChange={(e) =>
              onChange(rows.map((r, j) => (j === i ? { ...r, color: e.target.value } : r)))
            }
            className="ac-field w-auto px-1 py-1 text-xs"
            aria-label="选项颜色"
          >
            {LABEL_COLORS.map((c) => (
              <option key={c} value={c}>
                {COLOR_LABEL[c]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="px-1 text-ink-faint hover:text-high"
            aria-label="移除选项"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { name: "", color: "slate" }])}
        className="text-xs text-primary hover:underline"
      >
        ＋ 添加选项
      </button>
    </div>
  );
}

/** 新建属性入口（表格工具行） */
export function AddPropertyButton() {
  const store = useTaskDatabase();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<PropertyDef["type"]>("text");
  const [rows, setRows] = useState<OptionDraft[]>([{ name: "", color: "slate" }]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (!store.canWrite) return null;

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) return setError("属性名不可为空");
    if (SELECT_TYPES.includes(type) && rows.every((r) => !r.name.trim()))
      return setError("单选/多选至少需要一个选项名");
    setBusy(true);
    const ok = await store.createDef({
      name: trimmed,
      type,
      ...(SELECT_TYPES.includes(type)
        ? { options: rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), color: r.color })) }
        : {}),
    });
    setBusy(false);
    if (ok) {
      setOpen(false);
      setName("");
      setType("text");
      setRows([{ name: "", color: "slate" }]);
      setError("");
    }
  }

  return (
    <details className="relative" open={open}>
      <summary
        className="ac-btn-ghost cursor-pointer list-none whitespace-nowrap px-2 py-0.5 text-xs"
        onClick={(e) => {
          e.preventDefault();
          setOpen((v) => !v);
        }}
      >
        ＋ 属性
      </summary>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-56 rounded-lg border border-line bg-surface p-2 shadow-lg">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="属性名称（≤30 字）"
            className="ac-field w-full px-1.5 py-1 text-xs"
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as PropertyDef["type"])}
            className="ac-field mt-1.5 w-full px-1.5 py-1 text-xs"
            aria-label="属性类型"
          >
            {(Object.keys(TYPE_LABEL) as PropertyDef["type"][]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          {SELECT_TYPES.includes(type) && (
            <div className="mt-1.5">
              <OptionRows rows={rows} onChange={setRows} />
            </div>
          )}
          {error && <p className="mt-1.5 text-xs text-high">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-xs text-ink-faint hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="ac-btn px-2.5 py-1 text-xs"
            >
              {busy ? "创建中…" : "创建"}
            </button>
          </div>
        </div>
      )}
    </details>
  );
}

/** 自定义属性列头的 ⋯ 管理菜单 */
export function PropertyColumnMenu({ def }: { def: PropertyDef }) {
  const store = useTaskDatabase();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(def.name);
  const [editingOptions, setEditingOptions] = useState(false);
  const [optionRows, setOptionRows] = useState<OptionDraft[]>(
    (def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!store.canWrite) {
    return (
      <span className="text-[10px] font-normal text-ink-faint" title={`类型：${TYPE_LABEL[def.type]}`}>
        {TYPE_LABEL[def.type]}
      </span>
    );
  }

  async function saveName() {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === def.name) return setRenaming(false);
    const ok = await store.updateDef(def.id, { name: trimmed });
    if (ok) setRenaming(false);
  }

  const idx = store.defs.findIndex((d) => d.id === def.id);
  const move = (delta: -1 | 1) => {
    const ids = store.defs.map((d) => d.id);
    const j = idx + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    void store.reorderDefs(ids);
  };

  return (
    <>
      <details className="relative" open={open}>
        <summary
          className="cursor-pointer list-none rounded px-1 text-[10px] font-normal text-ink-faint hover:text-primary"
          onClick={(e) => {
            e.preventDefault();
            setOpen((v) => !v);
          }}
          title="属性管理"
        >
          ⋯
        </summary>
        {open && (
          <div className="absolute left-0 top-full z-40 mt-1 w-52 rounded-lg border border-line bg-surface p-2 text-xs shadow-lg">
            {renaming ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") setRenaming(false);
                  }}
                  className="ac-field min-w-0 flex-1 px-1.5 py-1"
                />
                <button type="button" onClick={() => void saveName()} className="text-primary hover:underline">
                  存
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-ink" title={def.name}>
                  {def.name}
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-ink-faint">
                  <span>{TYPE_LABEL[def.type]}</span>
                  <button type="button" onClick={() => setRenaming(true)} className="hover:text-primary" title="改名">
                    ✎
                  </button>
                </span>
              </div>
            )}

            {SELECT_TYPES.includes(def.type) && (
              <div className="mt-2 border-t border-line pt-2">
                {editingOptions ? (
                  <>
                    <OptionRows rows={optionRows} onChange={setOptionRows} />
                    <div className="mt-1.5 flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setOptionRows((def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })));
                          setEditingOptions(false);
                        }}
                        className="text-ink-faint hover:text-ink"
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          const options = optionRows
                            .filter((r) => r.name.trim())
                            .map((r) => ({ id: r.id, name: r.name.trim(), color: r.color }));
                          void store.updateDef(def.id, { options });
                          setEditingOptions(false);
                        }}
                        className="text-primary hover:underline"
                      >
                        保存选项
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="space-y-1">
                    {(def.options ?? []).map((o) => (
                      <div key={o.id} className="flex items-center gap-1.5">
                        <span className={`ac-badge px-1.5 py-0 text-[11px] ${LABEL_COLOR_CLASS[o.color] ?? ""}`}>
                          {o.name}
                        </span>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        setOptionRows((def.options ?? []).map((o) => ({ id: o.id, name: o.name, color: o.color })));
                        setEditingOptions(true);
                      }}
                      className="text-primary hover:underline"
                    >
                      管理选项
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={idx <= 0}
                  onClick={() => move(-1)}
                  className="text-ink-soft hover:text-primary disabled:opacity-30"
                  title="左移"
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={idx < 0 || idx >= store.defs.length - 1}
                  onClick={() => move(1)}
                  className="text-ink-soft hover:text-primary disabled:opacity-30"
                  title="右移"
                >
                  →
                </button>
              </span>
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="text-high hover:underline"
              >
                删除属性
              </button>
            </div>
          </div>
        )}
      </details>

      <ConfirmDangerDialog
        open={confirmDelete}
        title={`删除属性「${def.name}」`}
        confirmLabel="删除"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          void store.deleteDef(def.id);
        }}
      >
        <p className="text-sm text-ink-soft">
          该列将从所有视图移除，任务上已填的值一并清除且不可恢复。对所有成员生效。
        </p>
      </ConfirmDangerDialog>
    </>
  );
}
