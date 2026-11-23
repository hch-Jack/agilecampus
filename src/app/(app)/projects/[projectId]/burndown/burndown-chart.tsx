"use client";

import { useMemo, useRef, useState } from "react";
import type { BurndownIdeal, BurndownPoint } from "@/lib/burndown";

/**
 * 燃尽图（手写 SVG，零依赖）：
 * - 剩余任务：实线主色（主角线 2.25px）
 * - 总规模：中性灰细线（辅助参考）
 * - 理想线：浅色虚线阶梯——按剩余任务各自截止日归零（对齐真实排期）
 * - 节奏标注：近 14 天吞吐外推的完成日与按期/逾期结论
 * 悬停出十字线 + 数值提示；下方可展开逐日数据表（无障碍/可复制）。
 * 文字一律用 ink 色阶，颜色只属于线条本体（swatch 承载系列身份）。
 */

export type PaceNote = { text: string; tone: "ok" | "warn" | "flat" } | null;

const W = 760;
const H = 320;
const M = { top: 16, right: 96, bottom: 30, left: 38 };
const IW = W - M.left - M.right;
const IH = H - M.top - M.bottom;

const CSS = {
  main: "var(--color-primary)",
  scope: "var(--color-ink-faint)",
  ideal: "var(--color-line-strong)",
  grid: "var(--color-line)",
  today: "var(--color-ink-faint)",
  ink: "var(--color-ink)",
  soft: "var(--color-ink-soft)",
  faint: "var(--color-ink-faint)",
};

function dayNum(day: string) {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/** 阶梯（step-after）路径：值从变化日起持续到下一次变化 */
function stepPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  let lastY = pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y !== lastY) {
      d += ` L ${pts[i].x} ${lastY} L ${pts[i].x} ${pts[i].y}`;
      lastY = pts[i].y;
    }
  }
  d += ` L ${pts[pts.length - 1].x} ${lastY}`;
  return d;
}

/** y 轴刻度上限取「好看的整数步」 */
function niceMax(v: number): number {
  if (v <= 5) return Math.max(v, 1) * 1; // 1..5 一格一格
  const steps = [10, 20, 50, 100, 200, 500];
  for (const s of steps) if (v <= s) return Math.ceil(v / (s / 5)) * (s / 5);
  return Math.ceil(v / 100) * 100;
}

export function BurndownChart({
  points,
  ideal,
  todayDay,
  paceNote,
}: {
  points: BurndownPoint[];
  ideal: BurndownIdeal;
  todayDay: string;
  paceNote?: PaceNote;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const geom = useMemo(() => {
    const n = points.length;
    const maxTotal = Math.max(...points.map((p) => p.total), 1);
    const ymax = niceMax(maxTotal);
    const x = (i: number) => M.left + (n === 1 ? IW / 2 : (i / (n - 1)) * IW);
    const y = (v: number) => M.top + (1 - v / ymax) * IH;
    // x 轴刻度：首尾必有，中间均匀取 3~5 个
    const tickIdx = new Set<number>([0, n - 1]);
    const want = Math.min(5, Math.max(3, Math.floor(IW / 110)));
    for (let k = 1; k < want; k++) tickIdx.add(Math.round((k / want) * (n - 1)));
    // y 轴刻度：0 起按 ymax 均分 4 段
    const yTicks = [0, ymax / 4, ymax / 2, (ymax * 3) / 4, ymax];
    return { x, y, ymax, tickIdx: [...tickIdx].sort((a, b) => a - b), yTicks };
  }, [points]);

  const { x, y, tickIdx, yTicks } = geom;
  const last = points[points.length - 1];
  const first = points[0];

  // 理想线值（悬停提示用）：线性归零；锚点（今天）之前不存在
  // 理想线值（悬停提示用）：阶梯序列取「≤该日的最后一个值」前向携带；锚点前不存在
  const idealValue = (day: string) => {
    const n = dayNum(day);
    let v: number | null = null;
    for (const p of ideal) {
      if (dayNum(p.day) <= n) v = p.value;
      else break;
    }
    return v == null ? null : Math.round(v * 10) / 10;
  };

  // 理想线阶梯路径（day → 索引后复用 stepPath）
  const idealPath = useMemo(() => {
    if (ideal.length === 0) return "";
    const idxByDay = new Map(points.map((p, i) => [p.day, i]));
    const pts = ideal
      .map((p) => {
        const i = idxByDay.get(p.day);
        return i == null ? null : { x: x(i), y: y(p.value) };
      })
      .filter((p): p is { x: number; y: number } => p !== null);
    return stepPath(pts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ideal, points]);

  const todayIdx = points.findIndex((p) => p.day === todayDay);
  const todayX = todayIdx >= 0 ? x(todayIdx) : null;

  // 直接标注的 y 位置（右缘），靠太近时上下让位
  const mainEndY = y(last.remaining);
  const scopeEndY = y(last.total);
  const labelY = (() => {
    if (Math.abs(mainEndY - scopeEndY) < 16)
      return [scopeEndY - 9, scopeEndY + 9] as const; // [总规模在上, 剩余在下]
    return [scopeEndY, mainEndY] as const;
  })();

  const hovered = hover != null ? points[hover] : null;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const ratio = (px - M.left) / IW;
    const idx = Math.round(ratio * (points.length - 1));
    setHover(Math.min(Math.max(idx, 0), points.length - 1));
  }

  // 数据表只列「数值有变化的日子」+ 今天，避免逐日刷屏
  const tableRows = points.filter(
    (p, i) =>
      i === 0 ||
      p.remaining !== points[i - 1].remaining ||
      p.total !== points[i - 1].total ||
      p.day === todayDay,
  );

  return (
    <div className="ac-card p-4">
      {/* 图例（≥2 系列必有图例；文字用 ink 色，色样承载身份） */}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: CSS.main }} />
          剩余任务
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded" style={{ background: CSS.scope }} />
          总规模
        </span>
        {ideal.length > 0 && (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{ background: CSS.ideal, borderTop: "1.5px dashed" }}
            />
            理想（按任务截止日）
          </span>
        )}
        <span className="ml-auto text-ink-faint">顶层任务 · 按天</span>
      </div>

      {/* 节奏标注：吞吐外推的完成日与按期结论（warn/ok 用图标+文字双编码，不只靠色） */}
      {paceNote && (
        <p
          className={`mb-2 text-xs ${
            paceNote.tone === "warn"
              ? "text-high"
              : paceNote.tone === "ok"
                ? "text-done"
                : "text-ink-faint"
          }`}
        >
          {paceNote.tone === "warn" ? "⚠ " : paceNote.tone === "ok" ? "✓ " : ""}
          {paceNote.text}
        </p>
      )}

      <div ref={wrapRef} className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full touch-none select-none"
          role="img"
          aria-label="项目燃尽图：剩余任务数随时间变化"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* 网格与坐标（recessive） */}
          {yTicks.map((t) => (
            <g key={t}>
              <line
                x1={M.left} x2={W - M.right} y1={y(t)} y2={y(t)}
                stroke={CSS.grid} strokeWidth="1"
              />
              <text x={M.left - 6} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill={CSS.faint}>
                {Math.round(t)}
              </text>
            </g>
          ))}
          {tickIdx.map((i) => (
            <text
              key={i} x={x(i)} y={H - 10} textAnchor="middle" fontSize="10" fill={CSS.faint}
            >
              {points[i].day.slice(5).replace("-", "/")}
            </text>
          ))}

          {/* 今日竖线 */}
          {todayX != null && (
            <g>
              <line
                x1={todayX} x2={todayX} y1={M.top} y2={M.top + IH}
                stroke={CSS.today} strokeWidth="1" strokeDasharray="3 3"
              />
              <text x={todayX} y={M.top - 4} textAnchor="middle" fontSize="10" fill={CSS.faint}>
                今日
              </text>
            </g>
          )}

          {/* 理想线：按剩余任务各自截止日的阶梯（虚线） */}
          {idealPath && (
            <path
              d={idealPath}
              fill="none" stroke={CSS.ideal} strokeWidth="1.25"
              strokeDasharray="5 4" strokeLinejoin="round"
            />
          )}

          {/* 总规模（辅助）与剩余（主角，阶梯线） */}
          <path
            d={stepPath(points.map((p, i) => ({ x: x(i), y: y(p.total) })))}
            fill="none" stroke={CSS.scope} strokeWidth="1.75"
          />
          <path
            d={stepPath(points.map((p, i) => ({ x: x(i), y: y(p.remaining) })))}
            fill="none" stroke={CSS.main} strokeWidth="2.25" strokeLinejoin="round"
          />

          {/* 右缘直接标注（文字用 ink 色阶 + 色样） */}
          <g fontSize="10.5">
            <line x1={W - M.right + 6} x2={W - M.right + 18} y1={labelY[0]} y2={labelY[0]} stroke={CSS.scope} strokeWidth="1.75" />
            <text x={W - M.right + 21} y={labelY[0] + 3.5} fill={CSS.soft}>
              总规模 {last.total}
            </text>
            <line x1={W - M.right + 6} x2={W - M.right + 18} y1={labelY[1]} y2={labelY[1]} stroke={CSS.main} strokeWidth="2.25" />
            <text x={W - M.right + 21} y={labelY[1] + 3.5} fill={CSS.ink}>
              剩余 {last.remaining}
            </text>
          </g>

          {/* 悬停十字线 */}
          {hover != null && (
            <line
              x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + IH}
              stroke={CSS.soft} strokeWidth="1"
            />
          )}
        </svg>

        {/* 悬停数值提示（跟随十字线，出界自动翻边） */}
        {hovered && (
          <div
            className="pointer-events-none absolute top-2 z-10 min-w-28 rounded-field border border-line bg-surface px-2.5 py-1.5 text-xs shadow-lg"
            style={{
              left: `calc(${(x(hover!) / W) * 100}% + ${(x(hover!) / W > 0.6 ? -124 : 12)}px)`,
            }}
          >
            <p className="font-medium text-ink">{hovered.day.replace(/-/g, "/")}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-ink-soft">
              <span className="inline-block h-0.5 w-3" style={{ background: CSS.main }} />
              剩余 <span className="tabular-nums">{hovered.remaining}</span>
            </p>
            <p className="flex items-center gap-1.5 text-ink-soft">
              <span className="inline-block h-0.5 w-3" style={{ background: CSS.scope }} />
              总规模 <span className="tabular-nums">{hovered.total}</span>
            </p>
            {ideal && (
              <p className="flex items-center gap-1.5 text-ink-faint">
                <span className="inline-block h-0.5 w-3" style={{ background: CSS.ideal }} />
                理想 <span className="tabular-nums">{idealValue(hovered.day)}</span>
              </p>
            )}
          </div>
        )}
      </div>

      {/* 数据表（变化日 + 今日） */}
      <details className="mt-3 text-xs text-ink-soft">
        <summary className="cursor-pointer select-none text-ink-faint">逐日数据表</summary>
        <table className="mt-2 w-full max-w-md tabular-nums">
          <thead>
            <tr className="border-b border-line text-left text-ink-faint">
              <th className="py-1 pr-4 font-medium">日期</th>
              <th className="py-1 pr-4 font-medium">剩余</th>
              <th className="py-1 font-medium">总规模</th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((p) => (
              <tr key={p.day} className="border-b border-line last:border-b-0">
                <td className="py-1 pr-4">{p.day.replace(/-/g, "/")}</td>
                <td className="py-1 pr-4">{p.remaining}</td>
                <td className="py-1">{p.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5 text-ink-faint">
          仅列出数值有变化的日期；{first.day.replace(/-/g, "/")} 起 · 今日 {todayDay.replace(/-/g, "/")}
        </p>
      </details>
    </div>
  );
}
