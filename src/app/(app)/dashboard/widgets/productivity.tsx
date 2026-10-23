"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { dateIn, formatDateTime } from "@/lib/time";
import type {
  DashboardAttachment,
  DashboardMilestone,
  DashboardResourceUsage,
} from "../dashboard-types";
import { WidgetEmpty, WidgetShell } from "./shell";

// ------------------------------------------------------------------ 项目里程碑

/** 两个 YYYY-MM-DD 之间相差的天数（按 UTC 解析，不受时区 / 夏令时影响） */
function dayGap(today: string, target: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${target}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export function MilestonesWidget({
  milestones,
  today,
}: {
  milestones: DashboardMilestone[];
  today: string;
}) {
  return (
    <WidgetShell title="项目里程碑">
      {milestones.length === 0 ? (
        <WidgetEmpty>还没有待完成的里程碑</WidgetEmpty>
      ) : (
        <ul className="space-y-2">
          {milestones.map((milestone) => {
            const gap = dayGap(today, milestone.targetDate);
            const tone =
              gap < 0
                ? "bg-high-soft text-high"
                : gap <= 3
                  ? "bg-medium-soft text-medium"
                  : "bg-surface text-ink-soft";
            return (
              <li key={milestone.id}>
                <Link
                  href={`/projects/${milestone.projectId}`}
                  className="line-clamp-2 text-sm font-medium text-ink hover:text-primary"
                >
                  {milestone.title}
                </Link>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-faint">
                  <span className="truncate">{milestone.projectName}</span>
                  <span className={`ac-badge ${tone}`}>
                    {gap < 0
                      ? `${milestone.targetDate} 逾期`
                      : gap === 0
                        ? "今天"
                        : gap === 1
                          ? "明天"
                          : `${milestone.targetDate} · ${gap} 天后`}
                  </span>
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </WidgetShell>
  );
}

// ------------------------------------------------------------------ 团队资源占用

/** 只显示「月-日 时:分」，完整年份在资源页里看 */
function shortDateTime(tz: string, at: Date): string {
  return formatDateTime(tz, at).slice(5);
}

export function ResourceUsageWidget({
  usages,
  tz,
}: {
  usages: DashboardResourceUsage[];
  tz: string;
}) {
  return (
    <WidgetShell title="团队资源占用">
      {usages.length === 0 ? (
        <WidgetEmpty>还没有资源占用记录</WidgetEmpty>
      ) : (
        <ul className="space-y-2">
          {usages.map((usage) => (
            <li key={usage.id}>
              <div className="flex items-baseline justify-between gap-2">
                <Link
                  href={`/teams/${usage.teamId}/resources`}
                  className="truncate text-sm font-medium text-ink hover:text-primary"
                >
                  {usage.resourceName}
                </Link>
                <span
                  className={`ac-badge shrink-0 ${
                    usage.active ? "bg-high-soft text-high" : "bg-surface text-ink-faint"
                  }`}
                >
                  {usage.active ? "占用中" : "已结束"}
                </span>
              </div>
              <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                {usage.teamName} · {usage.userName} · {shortDateTime(tz, usage.startTime)} 起
                {usage.active ? null : usage.endTime ? ` · ${shortDateTime(tz, usage.endTime)} 止` : null}
              </p>
              {usage.purpose && (
                <p className="truncate text-[11px] text-ink-soft">{usage.purpose}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

// ------------------------------------------------------------------ 最近附件

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function RecentAttachmentsWidget({
  attachments,
  tz,
}: {
  attachments: DashboardAttachment[];
  tz: string;
}) {
  return (
    <WidgetShell title="最近附件">
      {attachments.length === 0 ? (
        <WidgetEmpty>还没有上传过附件</WidgetEmpty>
      ) : (
        <ul className="space-y-2">
          {attachments.map((attachment) => (
            <li key={attachment.id}>
              <Link
                href={`/projects/${attachment.projectId}/tasks/${attachment.taskId}`}
                className="block truncate text-sm font-medium text-ink hover:text-primary"
                title={attachment.filename}
              >
                {attachment.filename}
              </Link>
              <p className="mt-0.5 truncate text-[11px] text-ink-faint">
                {attachment.projectName} · {attachment.taskTitle} · {formatSize(attachment.size)}
                {" · "}
                {dateIn(tz, attachment.createdAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </WidgetShell>
  );
}

// ------------------------------------------------------------------ 专注计时

const FOCUS_SECONDS = 25 * 60;
const BREAK_SECONDS = 5 * 60;

type FocusPhase = "focus" | "break";
type StoredTimer = { phase: FocusPhase; remaining: number; endAt: number | null };

function phaseSeconds(phase: FocusPhase): number {
  return phase === "focus" ? FOCUS_SECONDS : BREAK_SECONDS;
}

function storageKey(instanceId: string): string {
  return `ac:focus-timer:${instanceId}`;
}

function loadTimer(instanceId: string): StoredTimer {
  const fallback: StoredTimer = { phase: "focus", remaining: FOCUS_SECONDS, endAt: null };
  try {
    const raw = window.localStorage.getItem(storageKey(instanceId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<StoredTimer>;
    const phase: FocusPhase = parsed.phase === "break" ? "break" : "focus";
    const remaining =
      typeof parsed.remaining === "number" && Number.isFinite(parsed.remaining)
        ? Math.min(Math.max(Math.floor(parsed.remaining), 0), phaseSeconds(phase))
        : phaseSeconds(phase);
    const endAt =
      typeof parsed.endAt === "number" && Number.isFinite(parsed.endAt) ? parsed.endAt : null;
    return { phase, remaining, endAt };
  } catch {
    return fallback;
  }
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * 番茄钟：纯客户端，进度存在 localStorage（按实例 id 分开）。
 * 页面刷新后继续走；首屏不读 localStorage，避免 hydration 不一致。
 */
export function FocusTimerWidget({ instanceId }: { instanceId: string }) {
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<FocusPhase>("focus");
  const [remaining, setRemaining] = useState(FOCUS_SECONDS);
  const [endAt, setEndAt] = useState<number | null>(null);

  // 挂载后再读 localStorage：服务端没有 window，首屏只能先渲染占位符
  useEffect(() => {
    const kick = setTimeout(() => {
      const stored = loadTimer(instanceId);
      setPhase(stored.phase);
      setRemaining(stored.remaining);
      setEndAt(stored.endAt);
      setReady(true);
    }, 0);
    return () => clearTimeout(kick);
  }, [instanceId]);

  // 运行中每秒按 endAt 重算——标签页被节流后回来也能自动对齐
  useEffect(() => {
    if (endAt === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      setRemaining(left);
      if (left <= 0) setEndAt(null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [endAt]);

  useEffect(() => {
    if (!ready) return;
    try {
      window.localStorage.setItem(
        storageKey(instanceId),
        JSON.stringify({ phase, remaining, endAt } satisfies StoredTimer),
      );
    } catch {
      // 隐私模式 / 配额满：计时照常，只是不跨刷新保留
    }
  }, [ready, instanceId, phase, remaining, endAt]);

  const running = endAt !== null;
  const finished = ready && remaining === 0;
  const label = phase === "focus" ? "专注" : "休息";

  function start() {
    const next = remaining > 0 ? remaining : phaseSeconds(phase);
    setRemaining(next);
    setEndAt(Date.now() + next * 1000);
  }

  function pause() {
    if (endAt === null) return;
    setRemaining(Math.max(0, Math.ceil((endAt - Date.now()) / 1000)));
    setEndAt(null);
  }

  function reset() {
    setEndAt(null);
    setRemaining(phaseSeconds(phase));
  }

  function switchPhase(next: FocusPhase) {
    setPhase(next);
    setEndAt(null);
    setRemaining(phaseSeconds(next));
  }

  return (
    <div className="flex h-full min-h-0 flex-col justify-center p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-ink-soft">{label}</p>
        <div className="flex shrink-0 items-center gap-1 text-[11px]">
          <button
            type="button"
            onClick={() => switchPhase("focus")}
            className={`rounded px-1.5 py-0.5 transition-colors ${
              phase === "focus" ? "bg-primary-soft text-primary" : "text-ink-faint hover:text-ink"
            }`}
          >
            专注
          </button>
          <button
            type="button"
            onClick={() => switchPhase("break")}
            className={`rounded px-1.5 py-0.5 transition-colors ${
              phase === "break" ? "bg-primary-soft text-primary" : "text-ink-faint hover:text-ink"
            }`}
          >
            休息
          </button>
        </div>
      </div>

      <p className="mt-1 font-display text-3xl font-semibold tabular-nums text-ink">
        {ready ? formatClock(remaining) : "--:--"}
      </p>
      <p className="mt-0.5 text-[11px] text-ink-faint">
        {finished ? "完成！休息一下" : running ? "进行中…" : "准备好就开始"}
      </p>

      <div className="mt-2 flex flex-wrap gap-2">
        {running ? (
          <button type="button" onClick={pause} className="ac-btn-ghost px-3 py-1 text-xs">
            暂停
          </button>
        ) : (
          <button type="button" onClick={start} className="ac-btn px-3 py-1 text-xs">
            {finished ? "再来一轮" : "开始"}
          </button>
        )}
        <button type="button" onClick={reset} className="ac-btn-ghost px-3 py-1 text-xs">
          重置
        </button>
      </div>
    </div>
  );
}
