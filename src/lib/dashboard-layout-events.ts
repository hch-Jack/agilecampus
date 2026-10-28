import type { DashboardLayoutDoc } from "./dashboard-layout";

/**
 * 「布局已在别处落库」的广播。
 *
 * 工作台与常驻栏的布局都只在挂载时从服务端播种一次（之后 router.refresh 带回的 props
 * 不得覆盖本地未保存的改动）。助手在面板里改了布局后，靠这个事件把**刚落库的文档**
 * 直接推给对应网格 —— 共享 layout（常驻栏）在客户端导航时根本不会重新渲染，等 props 也等不到。
 *
 * 纯浏览器事件，模块本身不碰 window（由调用方 dispatch / 监听），故可被两端引用的
 * 纯函数模块安全 import。
 */
export const LAYOUT_SAVED_EVENT = "ac:layout-saved";

export type LayoutSavedDetail = {
  surface: "dashboard" | "rail";
  doc: DashboardLayoutDoc;
};

export function isLayoutSavedDetail(value: unknown): value is LayoutSavedDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<LayoutSavedDetail>;
  return (
    (detail.surface === "dashboard" || detail.surface === "rail") &&
    !!detail.doc &&
    typeof detail.doc === "object" &&
    Array.isArray((detail.doc as DashboardLayoutDoc).items)
  );
}
