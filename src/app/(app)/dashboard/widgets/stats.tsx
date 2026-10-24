import { WORKBENCH_STAT_META, type WorkbenchStatKey } from "@/lib/workbench-stats";

/** 单张统计卡：大数字 + 标签 */
export function StatWidget({ statKey, value }: { statKey: WorkbenchStatKey; value: number }) {
  const meta = WORKBENCH_STAT_META[statKey];
  // 存在逾期任务时整张卡变橙提醒；0 时保持普通卡片，避免日常视图到处是警告色
  const alert = statKey === "overdue" && value > 0;
  return (
    <div className={`dw-stat flex h-full min-h-0 flex-col justify-center p-3 ${alert ? "is-alert" : ""}`}>
      <p className="dw-stat-label text-xs text-ink-soft">{meta.label}</p>
      <p
        className={`dw-stat-value font-display text-2xl font-semibold tabular-nums ${
          alert ? "" : meta.tone
        }`}
      >
        {value}
      </p>
    </div>
  );
}
