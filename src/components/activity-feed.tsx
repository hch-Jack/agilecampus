"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { dateIn } from "@/lib/time";
import type { TaskActivityRow } from "@/lib/activity";
import { clearFeedAction, markFeedReadAction } from "@/app/(app)/actions";

// 看板拖拽成功后的广播事件：detail 携带动态流 scope（"workbench" 或 "project:<id>"），
// 最新记录模块据此立即未读 +1。scope 字面量与 lib/activity 的 WORKBENCH_SCOPE/projectFeedScope 一致。
export const ACTIVITY_NEW_EVENT = "activity-feed:new";

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
// unreadScope 传入即启用未读角标：不随滚动自动消除，点「标记已读」才清零并上报服务端；
// 未读条目自身也带小红点。列表超高时内部滚动（最长 35vh）。
// clearScope 传入即显示「清除记录」：只清空当前用户自己看到的这条动态流，
// 库内数据与他人视图不动，此后新产生的记录照常显示。
export function ActivityFeed({
  activities,
  tz,
  now,
  showProject = false,
  unreadScope,
  unreadCount = 0,
  clearScope,
}: {
  activities: TaskActivityRow[];
  tz: string;
  now: Date;
  showProject?: boolean;
  unreadScope?: string;
  unreadCount?: number;
  clearScope?: string;
}) {
  const [unread, setUnread] = useState(unreadCount);
  const [clearPending, setClearPending] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const router = useRouter();

  // 服务端渲染的未读数变化时（如拖拽后 router.refresh 回流），在渲染期同步本地状态。
  // 官方「props 变化时重置 state」模式，避免 effect 内 setState 的级联渲染。
  // 值不变时不重跑——本地点「标记已读」的乐观清零不受回流干扰。
  const [lastUnreadCount, setLastUnreadCount] = useState(unreadCount);
  if (lastUnreadCount !== unreadCount) {
    setLastUnreadCount(unreadCount);
    setUnread(unreadCount);
  }

  // 看板拖拽成功会广播 ACTIVITY_NEW_EVENT（detail = scope）：
  // 本流的红点立即 +1，不用等 router.refresh 回流（覆盖「标记已读后
  // 立刻拖拽」的 1→1 场景——prop 值没变，单靠上面的渲染期同步不够）
  useEffect(() => {
    if (!unreadScope) return;
    const onNew = (e: Event) => {
      if ((e as CustomEvent<string>).detail === unreadScope) setUnread((n) => n + 1);
    };
    window.addEventListener(ACTIVITY_NEW_EVENT, onNew);
    return () => window.removeEventListener(ACTIVITY_NEW_EVENT, onNew);
  }, [unreadScope]);

  // 手动标记已读：乐观清角标并上报服务端（未登录/非法 scope 服务端静默忽略）
  function handleMarkRead() {
    if (!unreadScope || unread === 0) return;
    setUnread(0);
    void markFeedReadAction(unreadScope);
  }

  async function handleClear() {
    if (!clearScope || clearPending) return;
    if (
      !window.confirm(
        "确定清除你看到的全部最新记录吗？只影响你自己的显示，其他成员照常可见；之后新产生的记录会继续显示。",
      )
    ) {
      return;
    }
    setClearPending(true);
    setClearError(null);
    const res = await clearFeedAction(clearScope);
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
            <>
              <span
                aria-label={`${unread} 条未读`}
                className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-high px-1 text-[10px] font-semibold tabular-nums text-white"
              >
                {unread > 99 ? "99+" : unread}
              </span>
              <button
                onClick={handleMarkRead}
                className="text-xs font-normal text-ink-faint transition-colors hover:text-primary"
              >
                标记已读
              </button>
            </>
          )}
        </h2>
        {clearScope && (
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
        <ul className="mt-2 max-h-[35vh] space-y-1.5 overflow-y-auto pr-1">
          {activities.map((a, i) => {
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
                {/* 新消息红点：未读条目必然排在最前（createdAt 倒序、未读=晚于已读标记），
                    故索引 < unread 即新消息；点「标记已读」后全部消失 */}
                {i < unread && (
                  <span
                    aria-label="新消息"
                    className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-high align-middle"
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
