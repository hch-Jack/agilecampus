/**
 * 父任务卡片底部的子任务进度：完成数 / 总数 + 按比例填充的进度条。
 * 工作台看板与项目看板共用，保证两处观感一致；没有子任务时不渲染。
 */
export function SubtaskProgress({ total, done }: { total: number; done: number }) {
  if (total <= 0) return null;
  const percent = Math.round((Math.min(done, total) / total) * 100);

  return (
    <div className="mt-2">
      <p className="text-xs text-ink-faint">
        子任务{" "}
        <span className="tabular-nums">
          {done}/{total}
        </span>
      </p>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-sunken">
        <div className="h-full rounded-full bg-done" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
