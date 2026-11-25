"use client";

import { useEffect } from "react";
import { rememberLastProject } from "@/lib/last-project";

/** 静默记录最近打开的项目，供团队资源库的「返回项目」使用 */
export function LastProjectTracker({ projectId }: { projectId: string }) {
  useEffect(() => {
    rememberLastProject(projectId);
  }, [projectId]);
  return null;
}
