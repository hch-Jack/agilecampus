"use client";

import { useRouter } from "next/navigation";
import { readLastProject } from "@/lib/last-project";

/**
 * 团队资源库左上角「返回项目」：
 * - 从项目页进入时带 fromProject，直接回那个项目；
 * - 从顶栏/团队页进入时没有来源参数，回最近一次打开过的项目。
 */
export function BackToProjectButton({ projectId }: { projectId: string | null }) {
  const router = useRouter();

  function goBack() {
    const target = projectId ?? readLastProject();
    if (!target) {
      window.alert("还没有打开过项目，暂时没有可以返回的项目");
      return;
    }
    router.push(`/projects/${target}`);
  }

  return (
    <button
      type="button"
      onClick={goBack}
      className="text-xs text-ink-faint hover:text-primary"
      title={projectId ? "返回刚刚打开的项目" : "返回最近一次打开的项目"}
    >
      ← 返回项目
    </button>
  );
}
