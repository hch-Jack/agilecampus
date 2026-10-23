import { WORKBENCH_STAT_META, type WorkbenchStatKey, type WorkbenchStats } from "@/lib/workbench-stats";

/** 单张统计卡：大数字 + 标签 */
export function StatWidget({ statKey, value }: { statKey: WorkbenchStatKey; value: number }) {
  const meta = WORKBENCH_STAT_META[statKey];
  return (
    <div className="flex h-full min-h-0 flex-col justify-center px-4 py-3">
      <p className="text-xs text-ink-soft">{meta.label}</p>
      <p className={`font-display text-3xl font-semibold tabular-nums ${meta.tone}`}>{value}</p>
    </div>
  );
}

/** 四合一概览：容器够宽时一行四格，否则 2×2 */
export function StatsSummaryWidget({ stats }: { stats: WorkbenchStats }) {
  const keys = Object.keys(WORKBENCH_STAT_META) as WorkbenchStatKey[];
  return (
    <div className="dashboard-stat-summary flex h-full min-h-0 flex-col justify-center px-4 py-3">
      <p className="text-xs text-ink-soft">任务概览</p>
      <div className="dashboard-stat-summary-grid mt-1 grid grid-cols-2 gap-x-4 gap-y-1">
        {keys.map((key) => {
          const meta = WORKBENCH_STAT_META[key];
          return (
            <div key={key} className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-ink-faint">{meta.label}</span>
              <span className={`font-display text-xl font-semibold tabular-nums ${meta.tone}`}>
                {stats[key]}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
