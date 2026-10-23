"use client";

import { useEffect, useState } from "react";
import {
  COUNTDOWN_TITLE_MAX_LENGTH,
  NOTE_MAX_LENGTH,
  type DashboardWidgetConfig,
} from "@/lib/dashboard-layout";
import { clockParts, formatDateTime, zonedWallClockToInstant } from "@/lib/time";

export type ConfigChange = (patch: DashboardWidgetConfig, immediate?: boolean) => void;

/**
 * 首屏渲染 null（占位符），挂载后再走秒：服务端与浏览器的「现在」不同，
 * 直接渲染 Date 会 hydration 不一致。用定时器回调起第一次，避免 effect 内同步 setState。
 */
function useNow(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const update = () => setNow(new Date());
    const kick = setTimeout(update, 0);
    const ticker = setInterval(update, 1000);
    return () => {
      clearTimeout(kick);
      clearInterval(ticker);
    };
  }, []);
  return now;
}

// ------------------------------------------------------------------ 便签

export function NoteWidget({
  config,
  onConfigChange,
}: {
  config?: DashboardWidgetConfig;
  onConfigChange: ConfigChange;
}) {
  const [editing, setEditing] = useState(false);
  const text = config?.text ?? "";

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="font-display text-sm font-semibold text-ink">便签</h2>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-ink-faint transition-colors hover:text-primary"
          >
            编辑
          </button>
        )}
      </div>
      {editing ? (
        <textarea
          autoFocus
          value={text}
          maxLength={NOTE_MAX_LENGTH}
          onChange={(e) => onConfigChange({ text: e.target.value })}
          onBlur={() => {
            onConfigChange({}, true);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          placeholder="随手记下一句话…"
          className="ac-field mt-2 min-h-0 flex-1 resize-none text-sm"
        />
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-2 flex min-h-0 flex-1 items-start overflow-y-auto whitespace-pre-wrap break-words text-left text-sm text-ink-soft transition-colors hover:text-ink"
        >
          {text || <span className="text-ink-faint">点这里记点什么…</span>}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 时钟

export function ClockWidget({ tz }: { tz: string }) {
  const now = useNow();
  const parts = now ? clockParts(tz, now) : null;

  return (
    <div className="flex h-full min-h-0 flex-col justify-center p-4">
      <p className="font-display text-3xl font-semibold tabular-nums text-ink">
        {parts ? `${parts.hh}:${parts.mm}:${parts.ss}` : "--:--:--"}
      </p>
      <p className="mt-1 text-xs text-ink-faint">{parts ? parts.dateLabel : "按你的时区显示"}</p>
    </div>
  );
}

// ------------------------------------------------------------------ 倒计时

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

export function CountdownWidget({
  tz,
  config,
  onConfigChange,
}: {
  tz: string;
  config?: DashboardWidgetConfig;
  onConfigChange: ConfigChange;
}) {
  const [setting, setSetting] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftTarget, setDraftTarget] = useState("");
  const now = useNow();

  let target: Date | null = null;
  try {
    target = config?.targetAt ? zonedWallClockToInstant(tz, config.targetAt) : null;
  } catch {
    target = null;
  }

  function openSetting() {
    setDraftTitle(config?.title ?? "");
    setDraftTarget(config?.targetAt ?? "");
    setSetting(true);
  }

  function save() {
    onConfigChange(
      {
        title: draftTitle.slice(0, COUNTDOWN_TITLE_MAX_LENGTH),
        targetAt: draftTarget || undefined,
      },
      true,
    );
    setSetting(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col justify-center p-4">
      {setting ? (
        <div className="space-y-2">
          <input
            value={draftTitle}
            maxLength={COUNTDOWN_TITLE_MAX_LENGTH}
            onChange={(e) => setDraftTitle(e.target.value)}
            placeholder="倒计时标题（如：答辩）"
            className="ac-field text-sm"
          />
          <input
            type="datetime-local"
            value={draftTarget}
            onChange={(e) => setDraftTarget(e.target.value)}
            className="ac-field text-sm"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setSetting(false)}
              className="text-xs text-ink-faint hover:text-ink"
            >
              取消
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!draftTarget}
              className="ac-btn px-3 py-1 text-xs disabled:opacity-50"
            >
              保存
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-2">
            <p className="truncate text-xs text-ink-soft">{config?.title || "倒计时"}</p>
            <button
              type="button"
              onClick={openSetting}
              className="shrink-0 text-xs text-ink-faint transition-colors hover:text-primary"
            >
              设置
            </button>
          </div>
          {target ? (
            <>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-ink">
                {now ? (target.getTime() - now.getTime() > 0 ? formatRemaining(target.getTime() - now.getTime()) : "已到达") : "计算中…"}
              </p>
              <p className="mt-1 text-[11px] text-ink-faint">目标 {formatDateTime(tz, target)}</p>
            </>
          ) : (
            <p className="mt-1 text-sm text-ink-faint">点「设置」定一个目标时间</p>
          )}
        </>
      )}
    </div>
  );
}
