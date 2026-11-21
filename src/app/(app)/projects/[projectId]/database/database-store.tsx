"use client";

// 任务数据库 client Store（方案 D10）：tasks/defs/views 的前端唯一数据源。
// 视图配置的编辑走乐观更新 + 防抖持久化（saveViewAction，last-writer-wins），
// 任务字段/属性/状态的行内提交走乐观更新 + 服务端 action（失败回滚快照并提示），
// 成功后节流 router.refresh 让页面其他区块（动态流/看板区块）回流。
// in-flight 操作计数 > 0 期间不采纳服务端回流，防止旧快照冲掉尚未提交的乐观态。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { TeamRole } from "@/db/schema";
import type { PropertyDef } from "@/lib/properties";
import type { listProjectTasks } from "@/lib/task";
import type { ProjectView, TaskViewConfig } from "@/lib/database-views";
import {
  deleteViewAction,
  renameViewAction,
  saveViewAction,
  setTaskPropertiesAction,
  createPropertyDefAction,
  updatePropertyDefAction,
  deletePropertyDefAction,
  reorderPropertyDefsAction,
} from "../database-actions";
import { moveTaskAction, updateTaskFieldAction } from "../actions";

export type StoreTask = Awaited<ReturnType<typeof listProjectTasks>>[number];
export type StoreMember = { id: string; name: string };
export type StoreMilestone = { id: string; title: string };
export type StoreLabel = { id: string; name: string; color: string };

/** 行内编辑可提交的原生字段（labelIds 全量替换；status 走 patchStatus 保留审批/撤回语义） */
export type TaskFieldPatch = {
  title?: string;
  description?: string | null;
  assigneeId?: string | null;
  milestoneId?: string | null;
  priority?: "low" | "medium" | "high";
  startDate?: string | null;
  dueDate?: string | null;
  labelIds?: string[];
};

export type DatabaseStore = {
  projectId: string;
  tasks: StoreTask[];
  defs: PropertyDef[];
  views: ProjectView[];
  members: StoreMember[];
  milestones: StoreMilestone[];
  labels: StoreLabel[];
  canWrite: boolean;
  viewerRole: TeamRole;
  activeView: ProjectView | null;
  setActiveView(key: string): void;
  viewKey(view: Pick<ProjectView, "id" | "kind">): string;
  /** 当前视图 config 乐观更新；派生默认视图首次编辑会立即落库成持久视图 */
  patchConfig(config: TaskViewConfig): void;
  createView(kind: ProjectView["kind"], name: string): Promise<boolean>;
  renameView(viewId: string, name: string): Promise<boolean>;
  deleteView(viewId: string): Promise<boolean>;
  /** 行内编辑：原生字段（labelIds 全量替换语义） */
  updateTaskFields(taskId: string, patch: TaskFieldPatch): Promise<boolean>;
  /** 行内编辑：状态。走 moveTaskAction 保留撤回完成申请等拖拽语义（审批拦截在 lib） */
  patchStatus(taskId: string, status: "todo" | "doing" | "done"): Promise<boolean>;
  /** 行内编辑：自定义属性值（null/空=清键），服务端返回合并后的完整 properties */
  setTaskProps(taskId: string, values: Record<string, unknown>): Promise<boolean>;
  /** 属性定义管理 */
  createDef(input: {
    name: string;
    type: "text" | "number" | "select" | "multi_select" | "date" | "person" | "checkbox";
    options?: { id?: string; name: string; color: string }[];
  }): Promise<boolean>;
  updateDef(defId: string, patch: { name?: string; options?: { id?: string; name: string; color: string }[] }): Promise<boolean>;
  deleteDef(defId: string): Promise<boolean>;
  reorderDefs(orderedIds: string[]): Promise<boolean>;
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
/** 行内编辑成功后的回流节流：动态流/看板区块不用每次编辑都整页重渲染 */
const REFRESH_THROTTLE_MS = 4000;
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
  viewerRole,
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
  viewerRole: TeamRole;
  children: ReactNode;
}) {
  const router = useRouter();
  const [tasks, setTasks] = useState(initialTasks);
  const [defs, setDefs] = useState(initialDefs);
  const [views, setViews] = useState(initialViews);
  const [activeKey, setActiveKey] = useState(
    () => (initialViews[0] ? viewKey(initialViews[0]) : "kind:table"),
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [toast, setToast] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefresh = useRef(0);

  // 服务端真值回流：tasks 是与其他区块（看板拖拽等）共享的数据，props 变化时按 React
  // 官方的「渲染期调整状态」模式采纳（仅在无 in-flight 操作时，防旧快照冲掉乐观态）。
  // views/defs 由本模块独占写入，本地态即真值，不随回流回滚。
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

  const notify = useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 4000);
  }, []);

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

  /** 行内编辑成功后节流回流（其他区块的动态流/看板数据需要服务端新快照） */
  const scheduleRefresh = useCallback(() => {
    const due = lastRefresh.current + REFRESH_THROTTLE_MS;
    const wait = Math.max(0, due - Date.now());
    setTimeout(() => {
      if (Date.now() - lastRefresh.current >= REFRESH_THROTTLE_MS) {
        lastRefresh.current = Date.now();
        router.refresh();
      }
    }, wait);
  }, [router]);

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

  // ---------------------------------------------------------------- 任务行内编辑

  const updateTaskFields = useCallback(
    async (taskId: string, patch: TaskFieldPatch): Promise<boolean> => {
      const snapshot = tasks;
      const { labelIds, ...rest } = patch;
      setTasks((ts) =>
        ts.map((t) =>
          t.id === taskId
            ? {
                ...t,
                // undefined = 不改；null = 清空
                ...Object.fromEntries(
                  Object.entries(rest).filter(([, v]) => v !== undefined),
                ),
                ...(labelIds !== undefined
                  ? {
                      labels: labelIds.map(
                        (id) =>
                          labels.find((l) => l.id === id) ?? {
                            id,
                            name: "未知标签",
                            color: "slate",
                          },
                      ),
                    }
                  : {}),
              }
            : t,
        ),
      );
      const result = await runOp(() => updateTaskFieldAction({ taskId, projectId, patch }));
      if (!result || "error" in result) {
        setTasks(snapshot);
        if (result && "error" in result) notify(result.error);
        return false;
      }
      scheduleRefresh();
      return true;
    },
    [tasks, labels, projectId, runOp, notify, scheduleRefresh],
  );

  const patchStatus = useCallback(
    async (taskId: string, status: "todo" | "doing" | "done"): Promise<boolean> => {
      const snapshot = tasks;
      setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
      const result = await runOp(() => moveTaskAction({ taskId, projectId, patch: { status } }));
      if (!result || "error" in result) {
        setTasks(snapshot);
        if (result && "error" in result) notify(result.error);
        return false;
      }
      scheduleRefresh();
      return true;
    },
    [tasks, projectId, runOp, notify, scheduleRefresh],
  );

  const setTaskProps = useCallback(
    async (taskId: string, values: Record<string, unknown>): Promise<boolean> => {
      const snapshot = tasks;
      setTasks((ts) =>
        ts.map((t) =>
          t.id === taskId
            ? {
                ...t,
                properties: { ...(t.properties ?? {}) },
              }
            : t,
        ),
      );
      // 先把「清键」在本地体现（null = 删键），合法值交给服务端返回的合并结果对齐
      setTasks((ts) =>
        ts.map((t) => {
          if (t.id !== taskId) return t;
          const props = { ...(t.properties ?? {}) };
          for (const [k, v] of Object.entries(values)) {
            if (v === null || v === undefined || v === "") delete props[k];
            else props[k] = v;
          }
          return { ...t, properties: props };
        }),
      );
      const result = await runOp(() => setTaskPropertiesAction({ projectId, taskId, values }));
      if (!result || "error" in result) {
        setTasks(snapshot);
        if (result && "error" in result) notify(result.error);
        return false;
      }
      // 以服务端合并结果为准（键级合并的权威视图）
      const merged = result.properties;
      setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, properties: merged } : t)));
      scheduleRefresh();
      return true;
    },
    [tasks, projectId, runOp, notify, scheduleRefresh],
  );

  // ---------------------------------------------------------------- 属性定义管理

  const createDef = useCallback(
    async (input: Parameters<DatabaseStore["createDef"]>[0]): Promise<boolean> => {
      const result = await runOp(() => createPropertyDefAction({ projectId, ...input }));
      if (!result || "error" in result) {
        if (result && "error" in result) notify(result.error);
        return false;
      }
      setDefs((ds) => [...ds, result.def]);
      scheduleRefresh();
      return true;
    },
    [projectId, runOp, notify, scheduleRefresh],
  );

  const updateDef = useCallback(
    async (
      defId: string,
      patch: { name?: string; options?: { id?: string; name: string; color: string }[] },
    ): Promise<boolean> => {
      const snapshot = defs;
      const snapshotTasks = tasks;
      setDefs((ds) =>
        ds.map((d) =>
          d.id === defId
            ? {
                ...d,
                ...(patch.name !== undefined ? { name: patch.name } : {}),
                // 乐观态的缺省选项 id 先本地补 uuid，成功后以服务端返回的 def 对齐
                ...(patch.options !== undefined
                  ? {
                      options: patch.options.map((o) => ({
                        id: o.id ?? crypto.randomUUID(),
                        name: o.name,
                        color: o.color,
                      })),
                    }
                  : {}),
              }
            : d,
        ),
      );
      const result = await runOp(() => updatePropertyDefAction({ projectId, defId, ...patch }));
      if (!result || "error" in result) {
        setDefs(snapshot);
        setTasks(snapshotTasks);
        if (result && "error" in result) notify(result.error);
        return false;
      }
      setDefs((ds) => ds.map((d) => (d.id === defId ? result.def : d)));
      scheduleRefresh();
      return true;
    },
    [defs, tasks, projectId, runOp, notify, scheduleRefresh],
  );

  const deleteDef = useCallback(
    async (defId: string): Promise<boolean> => {
      const snapshot = defs;
      const snapshotTasks = tasks;
      // 乐观：定义移除 + 任务上对应键剥离（服务端在事务里做同样的事）
      setDefs((ds) => ds.filter((d) => d.id !== defId));
      setTasks((ts) =>
        ts.map((t) => {
          if (!t.properties || !(defId in t.properties)) return t;
          const props = { ...t.properties };
          delete props[defId];
          return { ...t, properties: props };
        }),
      );
      const result = await runOp(() => deletePropertyDefAction({ projectId, defId }));
      if (!result || "error" in result) {
        setDefs(snapshot);
        setTasks(snapshotTasks);
        if (result && "error" in result) notify(result.error);
        return false;
      }
      scheduleRefresh();
      return true;
    },
    [defs, tasks, projectId, runOp, notify, scheduleRefresh],
  );

  const reorderDefs = useCallback(
    async (orderedIds: string[]): Promise<boolean> => {
      const snapshot = defs;
      const order = new Map(orderedIds.map((id, i) => [id, i]));
      setDefs((ds) =>
        ds
          .map((d) => ({ ...d, position: order.get(d.id) ?? d.position }))
          .sort((a, b) => a.position - b.position),
      );
      const result = await runOp(() => reorderPropertyDefsAction({ projectId, defIds: orderedIds }));
      if (!result || "error" in result) {
        setDefs(snapshot);
        if (result && "error" in result) notify(result.error);
        return false;
      }
      scheduleRefresh();
      return true;
    },
    [defs, projectId, runOp, notify, scheduleRefresh],
  );

  const value = useMemo<DatabaseStore>(
    () => ({
      projectId,
      tasks,
      defs,
      views,
      members,
      milestones,
      labels,
      canWrite,
      viewerRole,
      activeView,
      setActiveView: setActiveKey,
      viewKey,
      patchConfig,
      createView,
      renameView,
      deleteView,
      updateTaskFields,
      patchStatus,
      setTaskProps,
      createDef,
      updateDef,
      deleteDef,
      reorderDefs,
      pending: pendingCount > 0,
    }),
    [
      projectId,
      tasks,
      defs,
      views,
      members,
      milestones,
      labels,
      canWrite,
      viewerRole,
      activeView,
      patchConfig,
      createView,
      renameView,
      deleteView,
      updateTaskFields,
      patchStatus,
      setTaskProps,
      createDef,
      updateDef,
      deleteDef,
      reorderDefs,
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
