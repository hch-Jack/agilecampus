/**
 * 「返回项目」的兜底目标：资源库可能是从顶栏打开的，没有来源项目参数，
 * 这时返回用户最近一次打开过的项目。
 */
export const LAST_PROJECT_KEY = "ac:last-project-id";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rememberLastProject(projectId: string): void {
  if (typeof window === "undefined" || !UUID_RE.test(projectId)) return;
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // 隐私模式/配额不足：忽略，返回按钮退化为无目标
  }
}

export function readLastProject(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const id = window.localStorage.getItem(LAST_PROJECT_KEY);
    return id && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}
