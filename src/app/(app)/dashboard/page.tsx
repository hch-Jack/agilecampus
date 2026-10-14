import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMySubtaskProgress, listMyTasks } from "@/lib/task";
import { listMyTaskActivities } from "@/lib/activity";
import { addDays, todayIn, weekdayOfDate } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { ActivityFeed } from "@/components/activity-feed";
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

  // 「今天 / 本周截止」一律按**用户自己的时区**在服务端算成 YYYY-MM-DD，
  // 再由服务端传给看板 —— 客户端不取时钟，免得同一个人在两处看到不同的「今天」。
  // 周日的算法也走日历字符串（addDays），不要用 setDate：那会把宿主时区绕回来。
  const tz = await resolveUserTimeZone(session.user.id);
  const now = new Date();
  const today = todayIn(tz, now);
  const weekEnd = addDays(today, (7 - weekdayOfDate(today)) % 7);

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

      <ActivityFeed activities={feed} tz={tz} now={now} showProject />
    </main>
  );
}
