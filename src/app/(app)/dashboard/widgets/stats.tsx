import { WORKBENCH_STAT_META, type WorkbenchStatKey } from "@/lib/workbench-stats";

/** 单张统计卡：大数字 + 标签 */
export function StatWidget({ statKey, value }: { statKey: WorkbenchStatKey; value: number }) {
  const meta = WORKBENCH_STAT_META[statKey];
  return (
    <div className="dw-stat flex h-full min-h-0 flex-col justify-center p-3">
      <p className="dw-stat-label text-xs text-ink-soft">{meta.label}</p>
      <p className={`dw-stat-value font-display text-2xl font-semibold tabular-nums ${meta.tone}`}>
        {value}
      </p>
    </div>
  );
}
