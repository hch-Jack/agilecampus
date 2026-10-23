import { WORKBENCH_STAT_META, type WorkbenchStatKey } from "@/lib/workbench-stats";

/** 单张统计卡：大数字 + 标签 */
export function StatWidget({ statKey, value }: { statKey: WorkbenchStatKey; value: number }) {
  const meta = WORKBENCH_STAT_META[statKey];
  return (
    <div className="flex h-full min-h-0 flex-col justify-center p-3">
      <p className="text-xs text-ink-soft">{meta.label}</p>
      <p className={`font-display text-2xl font-semibold tabular-nums ${meta.tone}`}>{value}</p>
    </div>
  );
}
