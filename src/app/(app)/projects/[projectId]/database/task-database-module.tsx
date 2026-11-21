"use client";

// 任务数据库模块（Notion 式）：视图页签 + 筛选/排序条 + 表格视图。
// 替换原「只读任务表格」区块；看板/时间线视图分别由 PR3/PR4 接入（PR2a 先给占位提示，
// 现阶段看板用页面上的看板区块、时间线用右上角「时间线」页）。
// 行内编辑与属性管理在 PR2b（表格先读后写，拆小 PR 便于评审）。
import { DatabaseStoreProvider, useTaskDatabase } from "./database-store";
import { FilterSortBar } from "./filter-sort-bar";
import { TableTaskView } from "./table-task-view";
import { ViewTabs } from "./view-tabs";
import type { listProjectTasks } from "@/lib/task";
import type { PropertyDef } from "@/lib/properties";
import type { ProjectView } from "@/lib/database-views";

type StoreTask = Awaited<ReturnType<typeof listProjectTasks>>[number];

function ModuleInner() {
  const store = useTaskDatabase();
  const view = store.activeView;
  const config = view?.config ?? {};

  return (
    <section className="ac-card space-y-3 overflow-hidden p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-medium text-ink">任务数据库</h2>
        <ViewTabs />
      </div>

      {view?.kind === "table" && (
        <>
          <FilterSortBar config={config} onChange={store.patchConfig} />
          <TableTaskView config={config} onChangeConfig={store.patchConfig} />
        </>
      )}
      {view && (view.kind === "board" || view.kind === "timeline") && (
        <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-ink-faint">
          {view.kind === "board"
            ? "看板视图将在下一个 PR 接入任务数据库（当前可使用下方看板区块）。"
            : "时间线视图即将接入任务数据库（当前可使用右上角「时间线」页）。"}
        </p>
      )}
      {!view && <p className="text-sm text-ink-faint">暂无视图。</p>}
    </section>
  );
}

export function TaskDatabaseModule({
  projectId,
  tasks,
  defs,
  views,
  members,
  milestones,
  labels,
  canWrite,
}: {
  projectId: string;
  tasks: StoreTask[];
  defs: PropertyDef[];
  views: ProjectView[];
  members: { id: string; name: string }[];
  milestones: { id: string; title: string }[];
  labels: { id: string; name: string; color: string }[];
  canWrite: boolean;
}) {
  return (
    <DatabaseStoreProvider
      projectId={projectId}
      initialTasks={tasks}
      initialDefs={defs}
      initialViews={views}
      members={members}
      milestones={milestones}
      labels={labels}
      canWrite={canWrite}
    >
      <ModuleInner />
    </DatabaseStoreProvider>
  );
}
