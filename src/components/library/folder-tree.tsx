"use client";

import { useState, type ReactNode } from "react";
import { FolderIcon } from "@/components/file-type-icon";
import type { FolderOption } from "@/app/(app)/library/actions";

export type FolderNode = FolderOption & { children: FolderNode[] };

/** 把服务端按深度优先返回的扁平列表还原成树（同级顺序保持不变） */
export function buildFolderTree(folders: FolderOption[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const stack: FolderNode[] = [];
  for (const folder of folders) {
    const node: FolderNode = { ...folder, children: [] };
    const parent = folder.depth > 0 ? (stack[folder.depth - 1] ?? roots[roots.length - 1]) : null;
    if (!parent) roots.push(node);
    else parent.children.push(node);
    stack.length = folder.depth;
    stack[folder.depth] = node;
  }
  return roots;
}

/**
 * 资源管理器式文件夹树：根目录一个节点，子文件夹缩进 + 可展开/收起。
 * 选中项用 value 控制；null = 根目录。
 */
export function FolderTree({
  folders,
  value,
  onChange,
  rootLabel,
  disabledId,
}: {
  folders: FolderOption[];
  value: string | null;
  onChange: (folderId: string | null) => void;
  rootLabel: string;
  /** 不能作为目标的节点（例如文件当前所在文件夹） */
  disabledId?: string | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = buildFolderTree(folders);

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function rowClass(active: boolean, disabled: boolean) {
    return `flex w-full items-center gap-1 rounded px-2 py-1 text-left text-sm ${
      disabled
        ? "cursor-not-allowed text-ink-faint opacity-60"
        : active
          ? "bg-primary-soft font-medium text-primary"
          : "text-ink hover:bg-sunken"
    }`;
  }

  function renderNode(node: FolderNode): ReactNode {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    const disabled = disabledId === node.id;
    return (
      <li key={node.id}>
        <div className="flex items-center" style={{ paddingLeft: `${node.depth * 16}px` }}>
          {hasChildren ? (
            <button
              type="button"
              aria-label={isCollapsed ? "展开" : "收起"}
              className="grid h-5 w-5 shrink-0 place-items-center rounded text-xs text-ink-faint hover:bg-sunken"
              onClick={() => toggle(node.id)}
            >
              {isCollapsed ? "▸" : "▾"}
            </button>
          ) : (
            <span className="h-5 w-5 shrink-0" />
          )}
          <button
            type="button"
            className={rowClass(value === node.id, disabled)}
            disabled={disabled}
            onClick={() => onChange(node.id)}
            title={node.name}
          >
            <FolderIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{node.name}</span>
            {node.isDefault && <span className="ml-1 text-[10px] text-ink-faint">默认</span>}
          </button>
        </div>
        {hasChildren && !isCollapsed && <ul>{node.children.map(renderNode)}</ul>}
      </li>
    );
  }

  return (
    <ul className="max-h-60 overflow-y-auto overscroll-contain rounded-field border border-line p-1">
      <li>
        <button
          type="button"
          className={rowClass(value === null, false)}
          onClick={() => onChange(null)}
        >
          <FolderIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{rootLabel}</span>
        </button>
      </li>
      {tree.map(renderNode)}
    </ul>
  );
}
