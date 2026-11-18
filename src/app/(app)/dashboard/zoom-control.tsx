"use client";

import {
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  normalizeTextScale,
  normalizeZoom,
} from "@/lib/dashboard-layout";

/** 步进控件：− / 百分比 / +，边界禁用。三种缩放共用同一套外观。 */
function ScaleControl({
  label,
  ariaLabel,
  title,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  title: string;
  value?: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const current = value ?? 1;
  const percent = Math.round(current * 100);
  const nudge = (dir: -1 | 1) =>
    onChange(Math.round((current + dir * step) * 100) / 100);

  return (
    <div
      className="dashboard-zoom flex items-center gap-1"
      role="group"
      aria-label={ariaLabel}
    >
      <span className="mr-0.5 text-xs text-ink-faint">{label}</span>
      <button
        type="button"
        onClick={() => nudge(-1)}
        disabled={current <= min + 1e-6}
        aria-label={`${label}缩小`}
        className="ac-btn-ghost px-2 py-1 text-xs disabled:opacity-40"
      >
        −
      </button>
      <span
        aria-live="polite"
        className="w-11 text-center text-xs tabular-nums text-ink-soft"
        title={title}
      >
        {percent}%
      </span>
      <button
        type="button"
        onClick={() => nudge(1)}
        disabled={current >= max - 1e-6}
        aria-label={`${label}放大`}
        className="ac-btn-ghost px-2 py-1 text-xs disabled:opacity-40"
      >
        +
      </button>
    </div>
  );
}

/** 网格密度：− / + 步进 10%，70%–150%。同样面积里改行高与间距（列数不变）。 */
export function ZoomControl({
  zoom,
  onChange,
}: {
  zoom?: number;
  onChange: (zoom: number) => void;
}) {
  return (
    <ScaleControl
      label="网格尺寸缩放"
      ariaLabel="网格尺寸缩放"
      title="同样大小里容纳更多或更少的格子"
      value={normalizeZoom(zoom)}
      min={ZOOM_MIN}
      max={ZOOM_MAX}
      step={ZOOM_STEP}
      onChange={onChange}
    />
  );
}

/** 全局文字大小：− / + 步进 5%，85%–130%，作用于工作台所有卡片的内容字号。 */
export function TextScaleControl({
  textScale,
  onChange,
}: {
  textScale?: number;
  onChange: (textScale: number) => void;
}) {
  return (
    <ScaleControl
      label="文字大小"
      ariaLabel="文字大小缩放"
      title="统一调整工作台卡片里的文字大小"
      value={normalizeTextScale(textScale)}
      min={TEXT_SCALE_MIN}
      max={TEXT_SCALE_MAX}
      step={TEXT_SCALE_STEP}
      onChange={onChange}
    />
  );
}
