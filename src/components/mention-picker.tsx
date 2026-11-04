"use client";

import { useEffect, useId, useRef, useState } from "react";

export type MentionMember = { id: string; name: string };

/**
 * @ 提醒选择器：弹层含「全选」+ 逐人复选。
 *
 * 选中 id 以隐藏 input（name="mentions"，重复字段）随所在表单递交，
 * 供 server action 的 formData.getAll("mentions") 读取——不侵入正文。
 * 自管开合与选中态，零全局样式改动；members 为空时整组不渲染。
 * 弹层向上展开（表单在卡片底部，向上避免溢出），点外部自动收起。
 */
export function MentionPicker({ members }: { members: MentionMember[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const panelId = useId();

  // 点选择器之外任意处收起弹层（含点回正文 textarea：先收起再让该处获焦）
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  if (members.length === 0) return null;

  const allSelected = selected.length === members.length;
  const toggleAll = (on: boolean) => setSelected(on ? members.map((m) => m.id) : []);
  const toggleOne = (id: string, on: boolean) =>
    setSelected((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));

  return (
    <div className="relative" ref={ref}>
      {/* 选中 id 作为重复隐藏字段递交 */}
      {selected.map((id) => (
        <input key={id} type="hidden" name="mentions" value={id} />
      ))}

      <button
        type="button"
        className="ac-btn-ghost px-2.5 py-1 text-xs"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        @ 提醒{selected.length > 0 ? `（${selected.length}）` : ""}
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute bottom-full left-0 z-20 mb-1 w-60 rounded-lg border border-line-strong bg-surface p-2 [box-shadow:var(--shadow-pop)]"
        >
          <label className="flex items-center gap-2 border-b border-line pb-1.5 text-xs font-medium text-ink">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) => toggleAll(e.target.checked)}
            />
            全选
          </label>
          <ul className="mt-1 max-h-52 space-y-0.5 overflow-auto">
            {members.map((m) => (
              <li key={m.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-ink hover:bg-sunken">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={(e) => toggleOne(m.id, e.target.checked)}
                  />
                  {m.name}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
