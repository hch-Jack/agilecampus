import type { TaskStatusCounts } from "@/lib/task-status-counts";

// 四种状态直接复用看板/徽章的语义色；文字一律走 ink 色阶，颜色只属于扇区本体。
const SEGMENTS = [
  { key: "todo", label: "待办", color: "var(--color-todo)" },
  { key: "doing", label: "进行中", color: "var(--color-doing)" },
  { key: "pending", label: "待审批", color: "var(--color-medium)" },
  { key: "done", label: "已完成", color: "var(--color-done)" },
] as const;

function pctLabel(count: number, total: number) {
  if (total === 0) return "0%";
  const value = (count / total) * 100;
  return `${Number.isInteger(value) ? value : value.toFixed(1)}%`;
}

export function TaskStatusPie({ counts }: { counts: TaskStatusCounts }) {
  const total = counts.todo + counts.doing + counts.pending + counts.done;
  const R = 44;
  const C = 2 * Math.PI * R;
  // 扇区之间留 2px 级别的表面空隙，靠留白分隔而不是描边
  const GAP = 1.5;

  let offset = 0;
  const arcs = SEGMENTS.map((segment) => {
    const length = total > 0 ? (counts[segment.key] / total) * C : 0;
    const arc = {
      ...segment,
      length,
      drawn: Math.max(length - GAP, 0.5),
      dashOffset: -(offset + GAP / 2),
    };
    offset += length;
    return arc;
  });

  return (
    <section className="ac-card flex h-full flex-col p-5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold text-ink">任务分布</h2>
        <span className="text-[11px] text-ink-faint">含子任务</span>
      </div>

      <div className="mt-2 flex flex-1 flex-col items-center justify-center gap-3">
        <svg
          viewBox="0 0 120 120"
          className="h-32 w-32 shrink-0"
          role="img"
          aria-label={`任务分布：待办 ${counts.todo} 个，进行中 ${counts.doing} 个，待审批 ${counts.pending} 个，已完成 ${counts.done} 个`}
        >
          <g transform="rotate(-90 60 60)">
            {total === 0 ? (
              <circle
                cx="60"
                cy="60"
                r={R}
                fill="none"
                stroke="var(--color-line)"
                strokeWidth="20"
              />
            ) : (
              arcs.map((arc) =>
                arc.length > 0 ? (
                  <circle
                    key={arc.key}
                    cx="60"
                    cy="60"
                    r={R}
                    fill="none"
                    stroke={arc.color}
                    strokeWidth="20"
                    strokeDasharray={`${arc.drawn} ${C - arc.drawn}`}
                    strokeDashoffset={arc.dashOffset}
                  >
                    <title>{`${arc.label}：${counts[arc.key]} 个（${pctLabel(counts[arc.key], total)}）`}</title>
                  </circle>
                ) : null,
              )
            )}
          </g>
          <text
            x="60"
            y="58"
            textAnchor="middle"
            fontSize="22"
            fontWeight="600"
            fill="var(--color-ink)"
          >
            {total}
          </text>
          <text x="60" y="75" textAnchor="middle" fontSize="9" fill="var(--color-ink-faint)">
            任务
          </text>
        </svg>

        <ul className="w-full space-y-1">
          {SEGMENTS.map((segment) => (
            <li key={segment.key} className="flex items-center justify-between gap-2 text-xs">
              <span className="flex items-center gap-1.5 text-ink-soft">
                <span
                  aria-hidden
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: segment.color }}
                />
                {segment.label}
              </span>
              <span className="tabular-nums text-ink-faint">
                {counts[segment.key]} 个 · {pctLabel(counts[segment.key], total)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
