"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  NODE_H,
  NODE_W,
  computeDependencyFlow,
  type Dependency,
  type FlowEdge,
  type FlowState,
  type FlowTask,
} from "@/lib/dependency-flow";
import type { FlowChildStat } from "@/lib/flow-scope";
import { dependencyNeighbors } from "@/lib/relationship-graph";

const FLOW_STATE: Record<
  FlowState,
  { label: string; dot: string; text: string }
> = {
  done: { label: "已完成", dot: "bg-done", text: "text-ink-faint" },
  doing: { label: "进行中", dot: "bg-doing", text: "text-doing" },
  ready: { label: "可开始", dot: "bg-accent", text: "text-accent" },
  blocked: { label: "等待前置", dot: "bg-todo", text: "text-ink-faint" },
};

export function DependencyFlow({
  projectId,
  tasks,
  dependencies,
  childStats,
}: {
  projectId: string;
  tasks: FlowTask[];
  dependencies: Dependency[];
  childStats: Record<string, FlowChildStat>;
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const layout = useMemo(
    () => computeDependencyFlow({ tasks, dependencies }),
    [tasks, dependencies],
  );
  const taskById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const isolatedTasks = useMemo(
    () =>
      layout.isolatedTaskIds
        .map((id) => taskById.get(id))
        .filter((task): task is FlowTask => task !== undefined),
    [layout.isolatedTaskIds, taskById],
  );

  const activeHoveredId =
    hoveredId && taskById.has(hoveredId) ? hoveredId : null;
  const relatedIds = useMemo(
    () =>
      activeHoveredId
        ? dependencyNeighbors(dependencies, activeHoveredId)
        : new Set<string>(),
    [dependencies, activeHoveredId],
  );
  const hasRelated = relatedIds.size > 1;

  if (tasks.length === 0) {
    return (
      <div className="ac-card p-8 text-center text-sm text-ink-soft">
        项目还没有任务。先在项目页创建任务，再回来看流程图。
      </div>
    );
  }

  const stateMeta = (node: (typeof layout.nodes)[number]) => {
    const meta = FLOW_STATE[node.flowState];
    return node.flowState === "blocked"
      ? { ...meta, label: `等待 ${node.blockedBy} 项前置` }
      : meta;
  };
  const progressPct =
    layout.progress.total === 0
      ? 0
      : Math.round((layout.progress.done / layout.progress.total) * 100);

  return (
    <div className="space-y-4">
      {layout.nodes.length > 0 ? (
        <div
          className="ac-card overflow-hidden"
          role="region"
          aria-label="任务依赖流程图"
        >
          <p className="sr-only">
            依赖流程图：{layout.phases.length} 个阶段、
            {layout.counts.edges} 条依赖、
            {layout.counts.crossLevel} 条历史跨层级依赖、
            {layout.counts.cyclic} 条循环依赖。箭头从前置任务指向后置任务；
            带序号的任务构成主线。
          </p>

          {/* 流程进度：整体完成度 + 当前阶段 */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2.5 text-xs text-ink-soft">
            <span className="font-medium text-ink">本层进度</span>
            <span
              className="h-1.5 w-32 overflow-hidden rounded-full bg-sunken"
              aria-hidden="true"
            >
              <span
                className="block h-full rounded-full bg-done"
                style={{ width: `${progressPct}%` }}
              />
            </span>
            <span className="tabular-nums">
              已完成 {layout.progress.done}/{layout.progress.total}
            </span>
            {layout.progress.currentLayer !== null && (
              <>
                <span className="text-ink-faint">·</span>
                <span>当前在阶段 {layout.progress.currentLayer + 1}</span>
              </>
            )}
            {layout.mainPathTaskIds.length > 0 && (
              <span className="ml-auto text-ink-faint">
                主线 {layout.mainPathTaskIds.length} 步
              </span>
            )}
          </div>

          <div className="max-h-[70vh] overflow-auto overscroll-contain">
            <div
              className="relative"
              style={{ width: layout.width, height: layout.height }}
            >
              {/* 阶段底色（z-0） */}
              {layout.phases.map((phase) => (
                <div
                  key={phase.layer}
                  className={`absolute z-0 rounded-xl border ${
                    phase.current
                      ? "border-accent/40 bg-accent/5"
                      : "border-line/60 bg-sunken/40"
                  }`}
                  style={{
                    left: phase.x,
                    top: phase.y,
                    width: phase.width,
                    height: phase.height,
                  }}
                >
                  <div className="flex items-center justify-between gap-2 px-2.5 pt-1.5 text-[10px]">
                    <span
                      className={
                        phase.current
                          ? "font-medium text-accent"
                          : "text-ink-faint"
                      }
                    >
                      {phase.current && "当前 · "}阶段 {phase.layer + 1}
                    </span>
                    <span className="tabular-nums text-ink-faint">
                      {phase.done}/{phase.total}
                    </span>
                  </div>
                </div>
              ))}

              {/* 连线（z-1，压在阶段底色之上、卡片之下） */}
              <svg
                className="pointer-events-none absolute inset-0 z-[1]"
                width={layout.width}
                height={layout.height}
                aria-hidden="true"
                focusable="false"
              >
                <defs>
                  {(
                    [
                      ["flow-arrow", "fill-ink-faint"],
                      ["flow-arrow-cross", "fill-high"],
                      ["flow-arrow-cycle", "fill-danger"],
                      ["flow-arrow-hot", "fill-accent"],
                      ["flow-arrow-main", "fill-primary"],
                    ] as const
                  ).map(([id, cls]) => (
                    <marker
                      key={id}
                      id={id}
                      viewBox="0 0 8 8"
                      refX="7"
                      refY="4"
                      markerWidth="8"
                      markerHeight="8"
                      markerUnits="userSpaceOnUse"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,0 L8,4 L0,8 z" className={cls} />
                    </marker>
                  ))}
                </defs>

                {/* 开始 / 结束锚点的连线 */}
                {layout.terminalEdges.map((edge, index) => (
                  <path
                    key={`terminal-${edge.from}-${index}`}
                    d={edge.path}
                    fill="none"
                    strokeWidth={1.25}
                    className="stroke-ink-faint opacity-45"
                    markerEnd="url(#flow-arrow)"
                  />
                ))}

                {layout.edges.map((edge) => {
                  const hot =
                    activeHoveredId !== null &&
                    (edge.predecessorId === activeHoveredId ||
                      edge.successorId === activeHoveredId);
                  return (
                    <path
                      key={`${edge.predecessorId}-${edge.successorId}`}
                      d={edge.path}
                      fill="none"
                      strokeWidth={edgeWidth(edge, hot)}
                      strokeDasharray={edgeDash(edge)}
                      className={edgeStroke(edge, hot)}
                      markerEnd={edgeMarker(edge, hot)}
                    />
                  );
                })}
              </svg>

              {/* 开始 / 结束 */}
              {layout.start && (
                <div
                  className="absolute z-10 flex items-center justify-center rounded-full border border-line bg-surface text-[11px] font-medium text-ink-soft shadow-sm"
                  style={{
                    left: layout.start.x,
                    top: layout.start.y,
                    width: layout.start.width,
                    height: layout.start.height,
                  }}
                >
                  开始
                </div>
              )}
              {layout.end && (
                <div
                  className="absolute z-10 flex items-center justify-center rounded-full border border-line bg-surface text-[11px] font-medium text-ink-soft shadow-sm"
                  style={{
                    left: layout.end.x,
                    top: layout.end.y,
                    width: layout.end.width,
                    height: layout.end.height,
                  }}
                >
                  结束
                </div>
              )}

              {/* 任务卡片 */}
              {layout.nodes.map((node) => {
                const dimmed = hasRelated && !relatedIds.has(node.task.id);
                const related =
                  activeHoveredId !== null && relatedIds.has(node.task.id);
                const meta = stateMeta(node);
                const stat = childStats[node.task.id];
                return (
                  <div
                    key={node.task.id}
                    className={`absolute z-10 rounded-lg border bg-surface shadow-sm transition-opacity ${
                      dimmed ? "opacity-35" : ""
                    } ${
                      related
                        ? "border-accent ring-1 ring-accent"
                        : node.step !== null
                          ? "border-primary/40 hover:border-primary"
                          : "border-line hover:border-primary"
                    }`}
                    style={{
                      left: node.x,
                      top: node.y,
                      width: NODE_W,
                      height: NODE_H,
                    }}
                    onMouseEnter={() => setHoveredId(node.task.id)}
                    onMouseLeave={() => setHoveredId(null)}
                  >
                    {/* 整张卡片点进任务详情；子流程入口在内容层之上单独拦截 */}
                    <Link
                      href={`/projects/${projectId}/tasks/${node.task.id}`}
                      className="absolute inset-0 z-10 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={`查看任务详情：${node.task.title}`}
                      onFocus={() => setHoveredId(node.task.id)}
                      onBlur={() => setHoveredId(null)}
                    />
                    <div
                      className={`pointer-events-none relative z-0 flex h-full flex-col justify-center gap-0.5 ${
                        node.step !== null ? "pl-8 pr-2" : "px-2.5"
                      }`}
                    >
                      {node.step !== null && (
                        <span
                          className="absolute left-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-canvas shadow-sm"
                          aria-label={`主线第 ${node.step} 步`}
                        >
                          {node.step}
                        </span>
                      )}
                      <span className="line-clamp-2 text-xs font-medium leading-snug text-ink">
                        {node.task.title}
                      </span>
                      <span
                        className={`flex w-full items-center gap-1 overflow-hidden text-[10px] ${meta.text}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${meta.dot}`}
                        />
                        <span className="truncate">{meta.label}</span>
                        {stat && (
                          <Link
                            href={`/projects/${projectId}/flow?parent=${node.task.id}`}
                            className="pointer-events-auto relative z-20 ml-auto shrink-0 rounded-full bg-primary-soft px-1.5 py-0.5 font-medium text-primary hover:bg-primary hover:text-canvas"
                            title={`${stat.done}/${stat.total} 个子任务已完成`}
                            aria-label={`进入「${node.task.title}」的子流程，共 ${stat.total} 个任务`}
                            onFocus={() => setHoveredId(node.task.id)}
                            onBlur={() => setHoveredId(null)}
                          >
                            子流程 {stat.total} →
                          </Link>
                        )}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-[11px] text-ink-soft">
            <LegendDot cls="bg-done" label="已完成" />
            <LegendDot cls="bg-doing" label="进行中" />
            <LegendDot cls="bg-accent" label="可开始" />
            <LegendDot cls="bg-todo" label="等待前置" />
            <LegendEdge
              label="主线（①→②→…）"
              stroke="currentColor"
              width={2}
              className="text-primary"
            />
            <LegendEdge label="依赖（前置 → 后置）" />
            {layout.counts.crossLevel > 0 && (
              <LegendEdge
                label="跨层级历史依赖"
                stroke="currentColor"
                dash="5 3"
                className="text-high"
              />
            )}
            {layout.counts.cyclic > 0 && (
              <LegendEdge
                label="循环依赖"
                stroke="currentColor"
                dash="2 3"
                className="text-danger"
              />
            )}
            <span className="ml-auto tabular-nums text-ink-faint">
              {layout.nodes.length}/{layout.counts.tasks} 个任务参与依赖 ·{" "}
              {layout.counts.edges}/{layout.counts.dependencies} 条依赖
              {layout.counts.crossLevel > 0 &&
                ` · ${layout.counts.crossLevel} 条跨层级`}
            </span>
          </div>
        </div>
      ) : (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          {dependencies.length === 0
            ? "这一层还没有设置任务依赖。在任务详情页编辑同级任务的后置关系后，这里会生成流程图。"
            : `现有 ${dependencies.length} 条依赖无法绘制：端点不在当前层或为自环。`}
        </div>
      )}

      {isolatedTasks.length > 0 && (
        <section className="ac-card p-4">
          <h2 className="text-xs font-medium text-ink-soft">
            暂无依赖（{isolatedTasks.length}）
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {isolatedTasks.map((task) => {
              const stat = childStats[task.id];
              return (
                <li key={task.id} className="flex items-center gap-1">
                  <Link
                    href={`/projects/${projectId}/tasks/${task.id}`}
                    className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-xs text-ink-soft transition-colors hover:border-primary hover:text-primary"
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        FLOW_STATE[
                          task.status === "done"
                            ? "done"
                            : task.status === "doing"
                              ? "doing"
                              : "ready"
                        ].dot
                      }`}
                    />
                    {task.title}
                  </Link>
                  {stat && (
                    <Link
                      href={`/projects/${projectId}/flow?parent=${task.id}`}
                      className="rounded-full border border-primary/40 bg-primary-soft px-2 py-1 text-[11px] font-medium text-primary transition-colors hover:bg-primary hover:text-canvas"
                      title={`${stat.done}/${stat.total} 个子任务已完成`}
                      aria-label={`进入「${task.title}」的子流程，共 ${stat.total} 个任务`}
                    >
                      子流程 {stat.total} →
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function edgeStroke(edge: FlowEdge, hot: boolean) {
  if (hot) return "stroke-accent";
  if (edge.cyclic) return "stroke-danger opacity-90";
  if (edge.crossLevel) return "stroke-high opacity-90";
  if (edge.mainPath) return "stroke-primary opacity-90";
  return "stroke-ink-faint opacity-60";
}

function edgeWidth(edge: FlowEdge, hot: boolean) {
  if (hot) return 2.6;
  if (edge.mainPath && !edge.cyclic && !edge.crossLevel) return 2;
  return 1.25;
}

function edgeDash(edge: FlowEdge) {
  if (edge.cyclic) return "2 3";
  if (edge.crossLevel) return "5 3";
  return undefined;
}

function edgeMarker(edge: FlowEdge, hot: boolean) {
  if (hot) return "url(#flow-arrow-hot)";
  if (edge.cyclic) return "url(#flow-arrow-cycle)";
  if (edge.crossLevel) return "url(#flow-arrow-cross)";
  if (edge.mainPath) return "url(#flow-arrow-main)";
  return "url(#flow-arrow)";
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-full ${cls}`} />
      {label}
    </span>
  );
}

function LegendEdge({
  label,
  stroke = "currentColor",
  dash,
  width = 1.2,
  className,
}: {
  label: string;
  stroke?: string;
  dash?: string;
  width?: number;
  className?: string;
}) {
  return (
    <span className={`flex items-center gap-1 ${className ?? ""}`}>
      <svg width="20" height="8" aria-hidden="true">
        <line
          x1="0"
          y1="4"
          x2="15"
          y2="4"
          stroke={stroke}
          strokeWidth={width}
          strokeDasharray={dash}
        />
        <path d="M15 1 L20 4 L15 7 z" fill="currentColor" />
      </svg>
      {label}
    </span>
  );
}
