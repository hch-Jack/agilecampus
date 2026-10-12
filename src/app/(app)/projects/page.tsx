import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { listMyProjects } from "@/lib/project";
import { CardSparkles } from "@/components/card-sparkles";

// 进度色相：0% 橙 → 100% 天蓝（色相 30 → 200），返回深/浅两端用于渐变
function progressColors(pct: number): { deep: string; light: string } {
  const hue = 30 + (pct / 100) * 170;
  return {
    deep: `hsl(${hue.toFixed(0)}, 82%, 44%)`,
    light: `hsl(${hue.toFixed(0)}, 55%, 80%)`,
  };
}

export default async function AllProjectsPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  const projects = await listMyProjects(session.user.id);

  return (
    <main className="mx-auto max-w-3xl space-y-8 py-8">
      <h1 className="font-display text-2xl font-semibold text-ink">所有项目</h1>
      {projects.length === 0 ? (
        <div className="ac-card p-8 text-center text-sm text-ink-soft">
          暂无项目——先在团队中创建。
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {projects.map((p) => {
            const pct = p.taskTotal > 0 ? (p.doneCount / p.taskTotal) * 100 : 0;
            const R = 20;
            const C = 2 * Math.PI * R;
            const { deep, light } = progressColors(pct);
            // 保留一位小数显示，整数时去掉多余的 .0
            const pctText = (Math.round(pct * 10) / 10).toFixed(1).replace(/\.0$/, "");
            return (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="ac-card ac-card-link group block p-4"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0 truncate font-display text-base font-semibold text-ink group-hover:text-primary">
                      {p.name}
                    </span>
                    {p.status === "archived" ? (
                      <span className="ac-badge bg-low-soft text-low">已归档</span>
                    ) : (
                      <span className="ac-badge bg-done/12 text-done">进行中</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-ink-faint">{p.teamName}</p>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-ink-soft">
                      <div>任务进度</div>
                      <div className="mt-0.5 tabular-nums text-ink-faint">
                        {p.doneCount}/{p.taskTotal}
                      </div>
                    </div>
                    <div className="relative h-14 w-14 shrink-0">
                      <svg viewBox="0 0 48 48" className="h-full w-full">
                        <defs>
                          <linearGradient id={`ring-${p.id}`} x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0%" stopColor={deep} />
                            <stop offset="100%" stopColor={light} />
                          </linearGradient>
                        </defs>
                        <g transform="rotate(-90 24 24)">
                          <circle
                            cx="24" cy="24" r="20" fill="none"
                            stroke="currentColor" strokeWidth="5"
                            className="text-line"
                          />
                          <circle
                            cx="24" cy="24" r="20" fill="none"
                            stroke={`url(#ring-${p.id})`} strokeWidth="5" strokeLinecap="round"
                            strokeDasharray={C}
                            strokeDashoffset={C * (1 - pct / 100)}
                          />
                        </g>
                      </svg>
                      <span className="absolute inset-0 grid place-items-center text-xs font-semibold text-ink">
                        {pctText}%
                      </span>
                    </div>
                  </div>
                  <CardSparkles />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
