"use client";

import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, normalizeZoom } from "@/lib/dashboard-layout";

/** 网格密度：− / + 步进 10%，70%–150%。同样面积里改行高与间距（列数不变）。 */
export function ZoomControl({
  zoom,
  onChange,
}: {
  zoom?: number;
  onChange: (zoom: number) => void;
}) {
  const current = normalizeZoom(zoom) ?? 1;
  const percent = Math.round(current * 100);
  const step = (dir: -1 | 1) =>
    onChange(Math.round((current + dir * ZOOM_STEP) * 10) / 10);

  return (
    <div
      className="dashboard-zoom flex items-center gap-1"
      role="group"
      aria-label="网格尺寸缩放"
    >
      <span className="mr-0.5 text-xs text-ink-faint">网格尺寸缩放</span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={current <= ZOOM_MIN}
        aria-label="缩小"
        className="ac-btn-ghost px-2 py-1 text-xs disabled:opacity-40"
      >
        −
      </button>
      <span
        aria-live="polite"
        className="w-11 text-center text-xs tabular-nums text-ink-soft"
        title="同样大小里容纳更多或更少的格子"
      >
        {percent}%
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={current >= ZOOM_MAX}
        aria-label="放大"
        className="ac-btn-ghost px-2 py-1 text-xs disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}
