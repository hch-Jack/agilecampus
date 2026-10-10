// 工作台 URL 筛选态 ↔ query 的拼装与归一。纯函数、无 IO、不取时钟，便于单测（照 board-filters.ts 先例）。

// 项目筛选归一：raw 须为 string 且出现在我的任务的 projectId 集合内，否则忽略回「全部」。
// 非法 uuid 天然被「不在集合」吞掉，无须 zod。
export function pickProjectFilter(
  raw: string | string[] | undefined,
  tasks: { projectId: string }[],
): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return tasks.some((t) => t.projectId === value) ? value : null;
}

// 项目 Chip 列表：按首次出现顺序去重
export function projectChips(
  tasks: { projectId: string; projectName: string }[],
): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const t of tasks) {
    if (!seen.has(t.projectId)) seen.set(t.projectId, t.projectName);
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

// 拼 /dashboard 的 href：hideDone 与 project 互不覆盖（页面上所有切换入口都必须走这里，
// 任何一处手拼 ? 都会把另一个参数踩掉）
export function dashboardHref(opts: { hideDone?: boolean; project?: string | null }): string {
  const qs = new URLSearchParams();
  if (opts.hideDone) qs.set("hideDone", "1");
  if (opts.project) qs.set("project", opts.project);
  const s = qs.toString();
  return s ? `/dashboard?${s}` : "/dashboard";
}
