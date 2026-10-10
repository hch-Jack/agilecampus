import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMySubtaskProgress, listMyTasks } from "@/lib/task";
import { listMyTaskActivities } from "@/lib/activity";
import {
  dashboardHref,
  pickProjectFilter,
  projectChips,
} from "@/lib/workbench-filters";
import { WorkbenchBoard, type WorkbenchTask } from "./workbench-board";

// 四个统计瓦片均基于全量列表（与「隐藏已完成」/项目筛选无关），且都排除已完成任务
type Tile = { label: string; count: number; tone: string };

function buildTiles(tasks: WorkbenchTask[], today: string, weekEnd: string): Tile[] {
  const open = tasks.filter((t) => t.status !== "done");
  return [
    { label: "逾期", count: open.filter((t) => t.dueDate && t.dueDate < today).length, tone: "text-high" },
    { label: "今天截止", count: open.filter((t) => t.dueDate === today).length, tone: "text-medium" },
    {
      label: "本周截止",
      count: open.filter((t) => t.dueDate && t.dueDate > today && t.dueDate <= weekEnd).length,
      tone: "text-doing",
    },
    { label: "进行中", count: tasks.filter((t) => t.status === "doing").length, tone: "text-doing" },
  ];
}

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
// 正确性前提：PG 与 Node 时区一致（timestamp 列无时区，部署时两侧须对齐）
function fmtRelative(d: Date, now: Date): string {
  const s = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}天前`;
  return d.toLocaleDateString("sv-SE");
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const hideDone = typeof sp.hideDone === "string" && sp.hideDone === "1";

  const session = await auth();
  if (!session?.user) redirect("/login");

  const [myTasks, feed] = await Promise.all([
    listMyTasks(session.user.id),
    listMyTaskActivities(session.user.id), // 全量口径，不受任何筛选影响
  ]);

  // 本地时区 YYYY-MM-DD（sv-SE 惯例，与项目总览页同款）；today 由服务端算好传给看板，客户端不取时钟
  const now = new Date();
  const today = now.toLocaleDateString("sv-SE");
  const sunday = new Date(now);
  sunday.setDate(now.getDate() + ((7 - now.getDay()) % 7));
  const weekEnd = sunday.toLocaleDateString("sv-SE");

  // 子任务进度合并进卡片数据（只认直接子级聚合的父 id）
  const byParent = new Map(
    (await listMySubtaskProgress(myTasks.map((t) => t.id))).flatMap((r) =>
      r.parentTaskId ? [[r.parentTaskId, r] as const] : [],
    ),
  );
  const enriched: WorkbenchTask[] = myTasks.map((t) => {
    const p = byParent.get(t.id);
    return p ? { ...t, subTotal: p.total, subDone: p.done } : t;
  });

  // 筛选管线：瓦片/动态流用全量；看板先过项目再过 hideDone
  const projectFilter = pickProjectFilter(sp.project, myTasks);
  const chips = projectChips(myTasks);
  const projectScoped = projectFilter
    ? enriched.filter((t) => t.projectId === projectFilter)
    : enriched;
  const tiles = buildTiles(enriched, today, weekEnd);
  const doneCount = projectScoped.filter((t) => t.status === "done").length;
  const visible = hideDone ? projectScoped.filter((t) => t.status !== "done") : projectScoped;

  return (
    <main className="mx-auto max-w-5xl space-y-6 py-8">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">工作台</h1>
          <p className="mt-0.5 text-xs text-ink-faint">
            各项目中分配给你的任务，按状态拖拽流转，点击标题查看详情
          </p>
        </div>
        <Link
          href={dashboardHref({ hideDone: !hideDone, project: projectFilter })}
          aria-pressed={hideDone}
          className={`ac-badge ${
            hideDone
              ? "bg-primary text-white"
              : "bg-surface text-ink-soft hover:bg-primary-soft"
          }`}
        >
          隐藏已完成
        </Link>
      </header>

      {myTasks.length > 0 && (
        <nav className="flex flex-wrap items-center gap-1.5" aria-label="按项目筛选">
          <Link
            href={dashboardHref({ hideDone, project: null })}
            aria-pressed={!projectFilter}
            className={`ac-badge ${
              !projectFilter
                ? "bg-primary text-white"
                : "bg-surface text-ink-soft hover:bg-primary-soft"
            }`}
          >
            全部
          </Link>
          {chips.map((c) => (
            <Link
              key={c.id}
              href={dashboardHref({ hideDone, project: c.id })}
              aria-pressed={projectFilter === c.id}
              className={`ac-badge ${
                projectFilter === c.id
                  ? "bg-primary text-white"
                  : "bg-surface text-ink-soft hover:bg-primary-soft"
              }`}
            >
              {c.name}
            </Link>
          ))}
        </nav>
      )}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="任务统计">
        {tiles.map((tile) => (
          <div key={tile.label} className="ac-card p-3">
            <p className="text-xs text-ink-soft">{tile.label}</p>
            <p className={`font-display text-2xl font-semibold tabular-nums ${tile.tone}`}>
              {tile.count}
            </p>
          </div>
        ))}
      </section>

      {myTasks.length === 0 ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          暂无分配给你的任务——去项目看板看看。
        </div>
      ) : (
        <WorkbenchBoard tasks={visible} today={today} doneCount={doneCount} hideDone={hideDone} />
      )}

      <section className="ac-card p-5">
        <h2 className="font-display text-lg font-semibold text-ink">最新记录</h2>
        {feed.length === 0 ? (
          <p className="mt-2 text-sm text-ink-faint">暂无动态</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {feed.map((a) => {
              const parts = feedParts(a);
              return (
                <li key={a.id} className="text-sm">
                  <span className="text-ink-faint">{a.projectName}:</span>{" "}
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
                  <span className="text-xs text-ink-faint">{fmtRelative(a.createdAt, now)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
