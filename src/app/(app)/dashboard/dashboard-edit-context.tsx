"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type DashboardEditState = {
  /** 工作台是否处于编辑模式；常驻栏复用同一个开关 */
  editing: boolean;
  setEditing: (editing: boolean) => void;
};

const DashboardEditContext = createContext<DashboardEditState | null>(null);

/**
 * 编辑态共享：(app) 布局里包一层，工作台的「编辑工作台」同时把左侧常驻栏切进编辑态。
 * 离开工作台（DashboardGrid 卸载）时由它把状态复位。
 */
export function DashboardEditProvider({ children }: { children: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const value = useMemo(() => ({ editing, setEditing }), [editing]);
  return <DashboardEditContext.Provider value={value}>{children}</DashboardEditContext.Provider>;
}

export function useDashboardEdit(): DashboardEditState {
  const ctx = useContext(DashboardEditContext);
  if (!ctx) throw new Error("useDashboardEdit 必须在 DashboardEditProvider 内使用");
  return ctx;
}
