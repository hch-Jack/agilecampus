// 顶栏导航的单一来源：桌面胶囊（nav-links）与移动端菜单（mobile-nav）共用。
// key 是分区前缀（用于判定当前页），href 是点击跳转目标。
// 消息不在这里：入口固定在顶栏右侧的「消息」按钮（AI 助手旁），见 messages-panel.tsx 的 MessagesToggle。
export const NAV_ITEMS = [
  { key: "/dashboard", href: "/dashboard", label: "工作台" },
  { key: "/projects", href: "/projects", label: "所有项目" },
  { key: "/teams", href: "/teams", label: "我的团队" },
  { key: "/settings", href: "/settings", label: "AI配置" },
] as const;

// 当前路径落在哪个导航分区（含子页）
export function activeNavKey(pathname: string): string {
  for (const it of NAV_ITEMS) {
    if (pathname.startsWith(it.key)) return it.key;
  }
  return "";
}
