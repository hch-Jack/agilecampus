import Link from "next/link";
import { z } from "zod";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getProjectForUser, listProjectMilestones } from "@/lib/project";
import { listProjectTasks } from "@/lib/task";
import {
  buildTimeScale,
  formatMonthDay as fmtMD,
  inferTaskSpan,
  parseDay,
} from "@/lib/gantt";
import { todayIn } from "@/lib/time";
import { resolveUserTimeZone } from "@/lib/time-pref";

type TaskRow = Awaited<ReturnType<typeof listProjectTasks>>[number];

interface Bar {
  id: string;
  title: string;
  status: string;
  leftPct: number;
  widthPct: number;
  overdue: boolean;
  rangeLabel: string;
}

export default async function TimelinePage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await auth();
  if (!session?.user) redirect("/login");
  if (!z.uuid().safeParse(projectId).success) notFound();

  const access = await getProjectForUser(session.user.id, projectId);
  if (!access) notFound();

  const [tasks, milestones] = await Promise.all([
    listProjectTasks(session.user.id, projectId),
    listProjectMilestones(session.user.id, projectId),
  ]);

  // 拆出「已排期」（至少有起始或截止日）与「未排期」
  const scheduled: { task: TaskRow; start: number; end: number }[] = [];
  const unscheduled: TaskRow[] = [];
  for (const t of tasks) {
    const span = inferTaskSpan(t.startDate, t.dueDate);
    if (!span) {
      unscheduled.push(t);
      continue;
    }
    scheduled.push({ task: t, ...span });
  }

  // 今日竖线：按**用户自己的时区**定「今天是哪一天」，再落到同一套日历坐标系上
  const tz = await resolveUserTimeZone(session.user.id);
  const todayMs = parseDay(todayIn(tz))!;

  return (
    <main className="mx-auto max-w-5xl space-y-6 py-8">
      <header className="space-y-1">
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <Link href={`/projects/${projectId}`} className="hover:text-primary">
            ← 返回项目
          </Link>
          <Link href={`/projects/${projectId}/graph`} className="hover:text-primary">
            关系图 →
          </Link>
          <Link href={`/projects/${projectId}/flow`} className="hover:text-primary">
            流程图 →
          </Link>
        </div>
        <h1 className="font-display text-2xl font-semibold text-ink">
          {access.project.name} · 时间线
        </h1>
        <p className="text-sm text-ink-soft">
          按里程碑分组，横条为任务的 [起始日→截止日]。逾期任务标红，竖线为今日。
        </p>
      </header>

      {scheduled.length === 0 ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          尚无已排期任务——给任务填上起始日或截止日，即可在此排成时间线。
        </div>
      ) : (
        <Gantt scheduled={scheduled} milestones={milestones} todayMs={todayMs} />
      )}

      {unscheduled.length > 0 && (
        <section className="ac-card p-4">
          <h2 className="mb-2 text-sm font-semibold text-ink">
            未排期（{unscheduled.length}）
          </h2>
          <ul className="flex flex-wrap gap-2">
            {unscheduled.map((t) => (
              <li key={t.id} className="ac-badge bg-sunken text-ink-soft">
                {t.title}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Gantt({
  scheduled,
  milestones,
  todayMs,
}: {
  scheduled: { task: TaskRow; start: number; end: number }[];
  milestones: { id: string; title: string }[];
  todayMs: number;
}) {
  // 时间范围：涵盖全部横条 + 今日，两端各留 4% 余白（关系图共用同一套算法）
  const scale = buildTimeScale({
    spans: scheduled.map((s) => ({ start: s.start, end: s.end })),
    milestoneTargetDates: [],
    projectStartDate: null,
    projectEndDate: null,
    todayMs,
  });
  const pct = scale.pct;
  const ticks = scale.ticks;
  const todayPct = pct(todayMs);

  // 按里程碑分组（保持里程碑顺序，末尾附「无里程碑」）
  const groups: { key: string; title: string; bars: Bar[] }[] = [];
  const ensure = (key: string, title: string) => {
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, title, bars: [] };
      groups.push(g);
    }
    return g;
  };
  for (const m of milestones) ensure(m.id, m.title);

  const STATUS_BAR: Record<string, string> = {
    todo: "bg-todo",
    doing: "bg-doing",
    done: "bg-done",
  };

  for (const { task, start, end } of scheduled) {
    const overdue =
      task.status !== "done" && task.dueDate !== null && (parseDay(task.dueDate) ?? 0) < todayMs;
    const bar: Bar = {
      id: task.id,
      title: task.title,
      status: task.status,
      leftPct: pct(start),
      widthPct: Math.max(pct(end) - pct(start), 1.5),
      overdue,
      rangeLabel: `${task.startDate ?? "…"}→${task.dueDate ?? "…"}`,
    };
    ensure(task.milestoneId ?? "__none__", "无里程碑").bars.push(bar);
  }

  const nonEmpty = groups.filter((g) => g.bars.length > 0);

  return (
    <div className="ac-card overflow-hidden">
      {/* 时间刻度头 */}
      <div className="relative border-b border-line bg-sunken/60 px-4 py-2">
        <div className="relative ml-40 h-4">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute -translate-x-1/2 text-[11px] tabular-nums text-ink-faint"
              style={{ left: `${pct(t)}%` }}
            >
              {fmtMD(t)}
            </span>
          ))}
        </div>
      </div>

      <div>
        {nonEmpty.map((g) => (
          <div key={g.key} className="border-b border-line last:border-b-0">
            <div className="bg-sunken/40 px-4 py-1.5 text-xs font-semibold text-ink-soft">
              {g.title}
            </div>
            <ul>
              {g.bars.map((b) => (
                <li key={b.id} className="flex items-center px-4 py-1.5">
                  <span className="w-40 shrink-0 truncate pr-2 text-xs text-ink" title={b.title}>
                    {b.title}
                  </span>
                  <span className="relative h-5 flex-1">
                    {todayPct >= 0 && todayPct <= 100 && (
                      <span
                        className="pointer-events-none absolute inset-y-0 w-px bg-accent/70"
                        style={{ left: `${todayPct}%` }}
                        aria-hidden
                      />
                    )}
                    <span
                      className={`absolute top-0 flex h-5 items-center overflow-hidden rounded px-1.5 text-[10px] text-white ${
                        b.overdue ? "bg-high" : STATUS_BAR[b.status] ?? "bg-todo"
                      }`}
                      style={{ left: `${b.leftPct}%`, width: `${b.widthPct}%`, minWidth: "2rem" }}
                      title={b.rangeLabel}
                    >
                      <span className="truncate">{b.rangeLabel}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {/* 图例 */}
      <div className="flex flex-wrap items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-soft">
        <Legend cls="bg-todo" label="待办" />
        <Legend cls="bg-doing" label="进行中" />
        <Legend cls="bg-done" label="已完成" />
        <Legend cls="bg-high" label="逾期" />
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-px bg-accent/70" /> 今日
        </span>
      </div>
    </div>
  );
}

function Legend({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${cls}`} />
      {label}
    </span>
  );
}
