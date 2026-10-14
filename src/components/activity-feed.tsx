"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dateIn } from "@/lib/time";
import type { TaskActivityRow } from "@/lib/activity";
import { clearProjectActivitiesAction, markFeedReadAction } from "@/app/(app)/actions";

// 动态行拆成「任务标题前 / 后」两段，标题内嵌为链接：
// 「把「2」的负责人从 未分配 改为 1」「完成了「父任务」的子任务「子A」」。
// 文案口径与详情页 activityLine 一致（重启子任务等），此处按链接拆段本地实现
function feedParts(a: {
  type: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
}): { before: string; after: string } {
  switch (a.type) {
    case "created":
      return { before: "创建了任务「", after: "」" };
    case "field":
      return {
        before: "把「",
        after: `」的${a.field ?? "字段"}从 ${a.oldValue ?? "无"} 改为 ${a.newValue ?? "无"}`,
      };
    case "subtask_added":
      return { before: "给「", after: `」添加了子任务「${a.newValue ?? ""}」` };
    case "subtask_done":
      return { before: "完成了「", after: `」的子任务「${a.newValue ?? ""}」` };
    case "subtask_reopened":
      return { before: "重启了「", after: `」的子任务「${a.newValue ?? ""}」` };
    case "subtask_deleted":
      return { before: "删除了「", after: `」的子任务「${a.newValue ?? ""}」` };
    case "attachment_added":
      return { before: "给「", after: `」上传了附件「${a.newValue ?? ""}」` };
    case "attachment_deleted":
      return { before: "删除了「", after: `」的附件「${a.newValue ?? ""}」` };
    default:
      return { before: "", after: `：${a.type}` };
  }
}

// 相对时间：传入 now 便于推导；时钟微小偏移自然落入「刚刚」。
// 超过一周就落到具体日期，那个日期要按**用户的**时区写（别用 toLocaleDateString，
// 它取的是宿主进程的时区，容器里就是 UTC）。
//
// 注意「几小时前」这类差值不受时区影响 —— 那是两个时刻相减，本来就没有时区可言。
function fmtRelative(d: Date, now: Date, tz: string): string {
  const s = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}天前`;
  return dateIn(tz, d);
}

// 工作台与项目页共用的「最新记录」模块：操作人 + 动作 + 任务链接 + 相对时间。
// showProject 控制「项目名:」前缀：工作台跨项目展示需要；项目页全是本项目动态，前缀冗余。
// unreadScope 传入即启用未读角标：最新一条进入视口视为已读，乐观清角标并上报服务端。
// clearProjectId 传入（仅项目管理员）即显示「清除记录」：清空该项目全部动态。
export function ActivityFeed({
  activities,
  tz,
  now,
  showProject = false,
  unreadScope,
  unreadCount = 0,
  clearProjectId,
}: {
  activities: TaskActivityRow[];
  tz: string;
  now: Date;
  showProject?: boolean;
  unreadScope?: string;
  unreadCount?: number;
  clearProjectId?: string;
}) {
  const [unread, setUnread] = useState(unreadCount);
  const [clearPending, setClearPending] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const router = useRouter();

  // 观察列表首条（最新一条）：只看到列表尾部还不算「翻到最新」，首条入视口才记已读
  useEffect(() => {
    if (!unreadScope || unread === 0) return;
    const target = listRef.current?.querySelector("li");
    if (!target) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        obs.disconnect();
        setUnread(0);
        void markFeedReadAction(unreadScope);
      },
      { threshold: 0 },
    );
    obs.observe(target);
    return () => obs.disconnect();
  }, [unreadScope, unread]);

  async function handleClear() {
    if (!clearProjectId || clearPending) return;
    if (
      !window.confirm(
        "确定清除该项目的全部最新记录吗？任务详情里的时间线也会一并清空，此操作不可恢复。",
      )
    ) {
      return;
    }
    setClearPending(true);
    setClearError(null);
    const res = await clearProjectActivitiesAction(clearProjectId);
    setClearPending(false);
    if (res?.error) {
      setClearError(res.error);
      return;
    }
    setUnread(0);
    router.refresh();
  }

  return (
    <section className="ac-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 font-display text-lg font-semibold text-ink">
          最新记录
          {unread > 0 && (
            <span
              aria-label={`${unread} 条未读`}
              className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-high px-1 text-[10px] font-semibold tabular-nums text-white"
            >
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </h2>
        {clearProjectId && (
          <button
            onClick={handleClear}
            disabled={clearPending}
            className="shrink-0 text-xs text-ink-faint transition-colors hover:text-high disabled:opacity-50"
          >
            {clearPending ? "清除中…" : "清除记录"}
          </button>
        )}
      </div>
      {clearError && <p className="mt-1 text-xs text-high">{clearError}</p>}
      {activities.length === 0 ? (
        <p className="mt-2 text-sm text-ink-faint">暂无动态</p>
      ) : (
        <ul ref={listRef} className="mt-2 space-y-1.5">
          {activities.map((a) => {
            const parts = feedParts(a);
            return (
              <li key={a.id} className="text-sm">
                {showProject && <span className="text-ink-faint">{a.projectName}:</span>}{" "}
                <span className="font-medium text-ink">{a.actorName}</span>{" "}
                <span className="text-ink-soft">
                  {parts.before}
                  <Link
                    href={`/projects/${a.projectId}/tasks/${a.taskId}`}
                    className="text-primary underline"
                  >
                    {a.taskTitle}
                  </Link>
                  {parts.after}
                </span>{" "}
                <span className="text-xs text-ink-faint">{fmtRelative(a.createdAt, now, tz)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
