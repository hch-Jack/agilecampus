"use client";

// 任务数据库 client Store（方案 D10）：tasks/defs/views 的前端唯一数据源。
// 视图配置的编辑走乐观更新 + 防抖持久化（saveViewAction，last-writer-wins），
// 失败回滚到快照并提示。in-flight 操作计数 > 0 期间不采纳服务端回流，
// 防止其他区块触发 refresh 的旧快照冲掉尚未提交的乐观态。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { PropertyDef } from "@/lib/properties";
import type { listProjectTasks } from "@/lib/task";
import type { ProjectView, TaskViewConfig } from "@/lib/database-views";
import { deleteViewAction, renameViewAction, saveViewAction } from "../database-actions";

export type StoreTask = Awaited<ReturnType<typeof listProjectTasks>>[number];
export type StoreMember = { id: string; name: string };
export type StoreMilestone = { id: string; title: string };
export type StoreLabel = { id: string; name: string; color: string };

export type DatabaseStore = {
  projectId: string;
  tasks: StoreTask[];
  defs: PropertyDef[];
  views: ProjectView[];
  members: StoreMember[];
  milestones: StoreMilestone[];
  labels: StoreLabel[];
  canWrite: boolean;
  activeView: ProjectView | null;
  setActiveView(key: string): void;
  viewKey(view: Pick<ProjectView, "id" | "kind">): string;
  /** 当前视图 config 乐观更新；派生默认视图首次编辑会立即落库成持久视图 */
  patchConfig(config: TaskViewConfig): void;
  createView(kind: ProjectView["kind"], name: string): Promise<boolean>;
  renameView(viewId: string, name: string): Promise<boolean>;
  deleteView(viewId: string): Promise<boolean>;
  /** 提交中（乐观态保护窗口），UI 可据此禁用按钮 */
  pending: boolean;
};

const DatabaseContext = createContext<DatabaseStore | null>(null);

export function useTaskDatabase(): DatabaseStore {
  const store = useContext(DatabaseContext);
  if (!store) throw new Error("useTaskDatabase 必须在 DatabaseStoreProvider 内使用");
  return store;
}

const SAVE_DEBOUNCE_MS = 1000;
const viewKey = (v: Pick<ProjectView, "id" | "kind">) => v.id ?? `kind:${v.kind}`;

export function DatabaseStoreProvider({
  projectId,
  initialTasks,
  initialDefs,
  initialViews,
  members,
  milestones,
  labels,
  canWrite,
  children,
}: {
  projectId: string;
  initialTasks: StoreTask[];
  initialDefs: PropertyDef[];
  initialViews: ProjectView[];
  members: StoreMember[];
  milestones: StoreMilestone[];
  labels: StoreLabel[];
  canWrite: boolean;
  children: ReactNode;
}) {
  const [tasks, setTasks] = useState(initialTasks);
  const [views, setViews] = useState(initialViews);
  const [activeKey, setActiveKey] = useState(
    () => (initialViews[0] ? viewKey(initialViews[0]) : "kind:table"),
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [toast, setToast] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 服务端真值回流：tasks 是与其他区块（看板拖拽等）共享的数据，props 变化时按 React
  // 官方的「渲染期调整状态」模式采纳（仅在无 in-flight 操作时，防旧快照冲掉乐观态）。
  // views 由本模块独占写入，本地态即真值，不随回流回滚。
  const [lastServerTasks, setLastServerTasks] = useState(initialTasks);
  if (lastServerTasks !== initialTasks) {
    setLastServerTasks(initialTasks);
    if (pendingCount === 0) setTasks(initialTasks);
  }

  // 失焦的视图由 ?? views[0] 兜底，无需额外 effect 修正 activeKey
  const activeView = useMemo(
    () => views.find((v) => viewKey(v) === activeKey) ?? views[0] ?? null,
    [views, activeKey],
  );

  const notify = useCallback(
    (message: string) => {
      setToast(message);
      setTimeout(() => setToast(""), 4000);
    },
    [],
  );

  /** 包一层 in-flight 计数；action 返回 {error} 或抛异常由调用方统一处理 */
  const runOp = useCallback(
    async <T,>(fn: () => Promise<{ error: string } | T>): Promise<{ error: string } | T> => {
      setPendingCount((p) => p + 1);
      try {
        return await fn();
      } finally {
        setPendingCount((p) => p - 1);
      }
    },
    [],
  );

  const persistConfig = useCallback(
    async (
      viewId: string,
      kind: ProjectView["kind"],
      name: string,
      config: TaskViewConfig,
      snapshot: ProjectView[],
    ) => {
      const result = await runOp(() => saveViewAction({ projectId, id: viewId, kind, name, config }));
      if (!result || "error" in result) {
        setViews(snapshot);
        if (result && "error" in result) notify(result.error);
      }
    },
    [projectId, runOp, notify],
  );

  const patchConfig = useCallback(
    (config: TaskViewConfig) => {
      const cur = activeView;
      if (!cur) return;
      const snapshot = views;
      if (!cur.id) {
        // 派生的内置默认视图首次编辑：立即落库为持久视图（其 config 从此以库内为准）
        void (async () => {
          const result = await runOp(() =>
            saveViewAction({ projectId, kind: cur.kind, name: cur.name, config }),
          );
          if (!result || "error" in result) {
            if (result && "error" in result) notify(result.error);
            setViews(snapshot);
            return;
          }
          const saved = result.view;
          setViews((vs) => vs.map((v) => (viewKey(v) === viewKey(cur) ? saved : v)));
          setActiveKey(viewKey(saved));
        })();
        return;
      }
      setViews((vs) => vs.map((v) => (v.id === cur.id ? { ...v, config } : v)));
      const viewId = cur.id;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persistConfig(viewId, cur.kind, cur.name, config, snapshot);
      }, SAVE_DEBOUNCE_MS);
    },
    [activeView, views, projectId, runOp, notify, persistConfig],
  );

  const createView = useCallback(
    async (kind: ProjectView["kind"], name: string): Promise<boolean> => {
      const result = await runOp(() => saveViewAction({ projectId, kind, name, config: {} }));
      if (!result || "error" in result) {
        if (result && "error" in result) notify(result.error);
        return false;
      }
      setViews((vs) => [...vs, result.view]);
      setActiveKey(viewKey(result.view));
      return true;
    },
    [projectId, runOp, notify],
  );

  const renameView = useCallback(
    async (viewId: string, name: string): Promise<boolean> => {
      const snapshot = views;
      setViews((vs) => vs.map((v) => (v.id === viewId ? { ...v, name } : v)));
      const result = await runOp(() => renameViewAction({ projectId, viewId, name }));
      if (!result || "error" in result) {
        if (result && "error" in result) notify(result.error);
        setViews(snapshot);
        return false;
      }
      setViews((vs) => vs.map((v) => (v.id === viewId ? result.view : v)));
      return true;
    },
    [views, projectId, runOp, notify],
  );

  const deleteView = useCallback(
    async (viewId: string): Promise<boolean> => {
      const snapshot = views;
      const removed = views.find((v) => v.id === viewId);
      setViews((vs) => vs.filter((v) => v.id !== viewId));
      if (removed && viewKey(removed) === activeKey) {
        const next = views.find((v) => v.id !== viewId);
        if (next) setActiveKey(viewKey(next));
      }
      const result = await runOp(() => deleteViewAction({ projectId, viewId }));
      if (!result || "error" in result) {
        if (result && "error" in result) notify(result.error);
        setViews(snapshot);
        return false;
      }
      return true;
    },
    [views, activeKey, projectId, runOp, notify],
  );

  const value = useMemo<DatabaseStore>(
    () => ({
      projectId,
      tasks,
      defs: initialDefs,
      views,
      members,
      milestones,
      labels,
      canWrite,
      activeView,
      setActiveView: setActiveKey,
      viewKey,
      patchConfig,
      createView,
      renameView,
      deleteView,
      pending: pendingCount > 0,
    }),
    [
      projectId,
      tasks,
      initialDefs,
      views,
      members,
      milestones,
      labels,
      canWrite,
      activeView,
      patchConfig,
      createView,
      renameView,
      deleteView,
      pendingCount,
    ],
  );

  return (
    <DatabaseContext.Provider value={value}>
      {children}
      {toast && (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-high-soft px-4 py-2 text-sm text-high shadow-lg">
          {toast}
        </div>
      )}
    </DatabaseContext.Provider>
  );
}
