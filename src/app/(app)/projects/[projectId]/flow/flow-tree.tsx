import Link from "next/link";
import type { FlowTreeNode } from "@/lib/flow-scope";

const STATUS_DOT: Record<string, string> = {
  todo: "bg-todo",
  doing: "bg-doing",
  done: "bg-done",
};

/**
 * 左侧任务层级树。
 * - 「顶层流程」永远可点；
 * - 有子任务的父任务可点，进入它的子流程；
 * - 叶子任务只作为层级展示，不参与流程导航。
 */
export function FlowTree({
  projectId,
  currentParentId,
  roots,
}: {
  projectId: string;
  currentParentId: string | null;
  roots: FlowTreeNode[];
}) {
  const base = `/projects/${projectId}/flow`;

  return (
    <aside className="ac-card p-3 lg:sticky lg:top-6">
      <h2 className="mb-2 px-1 text-xs font-medium text-ink-soft">任务层级</h2>
      <nav
        aria-label="任务层级"
        className="max-h-56 overflow-auto overscroll-contain pr-1 lg:max-h-[70vh]"
      >
        <ul className="space-y-0.5">
          <li>
            <Link
              href={base}
              aria-current={currentParentId === null ? "page" : undefined}
              className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs ${
                currentParentId === null
                  ? "bg-primary-soft font-medium text-primary"
                  : "text-ink-soft hover:bg-sunken hover:text-ink"
              }`}
            >
              <span className="truncate">顶层流程</span>
              <span className="ml-auto text-[10px] tabular-nums text-ink-faint">
                {roots.length}
              </span>
            </Link>
          </li>
        </ul>

        <ul className="mt-0.5 space-y-0.5">
          {roots.map((node) => (
            <TreeItem
              key={node.task.id}
              node={node}
              projectId={projectId}
              currentParentId={currentParentId}
            />
          ))}
        </ul>
      </nav>
      <p className="mt-2 border-t border-line px-1 pt-2 text-[10px] leading-relaxed text-ink-faint">
        流程只画同一父任务下的任务；点有子任务的条目查看它的子流程。
      </p>
    </aside>
  );
}

function TreeItem({
  node,
  projectId,
  currentParentId,
}: {
  node: FlowTreeNode;
  projectId: string;
  currentParentId: string | null;
}) {
  const hasChildren = node.children.length > 0;
  const current = currentParentId === node.task.id;
  const dot = STATUS_DOT[node.task.status] ?? "bg-todo";

  const label = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate">{node.task.title}</span>
      {hasChildren && (
        <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-faint">
          {node.children.length}
        </span>
      )}
    </span>
  );

  return (
    <li>
      {hasChildren ? (
        <Link
          href={`/projects/${projectId}/flow?parent=${node.task.id}`}
          aria-current={current ? "page" : undefined}
          title={node.task.title}
          className={`flex items-center rounded-md px-1.5 py-1 text-xs ${
            current
              ? "bg-primary-soft font-medium text-primary"
              : "text-ink-soft hover:bg-sunken hover:text-ink"
          }`}
        >
          {label}
        </Link>
      ) : (
        <div
          className="flex items-center rounded-md px-1.5 py-1 text-xs text-ink-faint"
          title={node.task.title}
        >
          {label}
        </div>
      )}

      {hasChildren && (
        <ul className="ml-2.5 border-l border-line/70 pl-1.5">
          {node.children.map((child) => (
            <TreeItem
              key={child.task.id}
              node={child}
              projectId={projectId}
              currentParentId={currentParentId}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
