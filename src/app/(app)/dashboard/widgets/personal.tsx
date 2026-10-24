"use client";

import { useEffect, useState } from "react";
import {
  CLOCK_MAX_ZONES,
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
    <div className="dw-note flex h-full min-h-0 flex-col p-3">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="dw-shell-title font-display text-sm font-semibold text-ink">便签</h2>
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
          className="ac-scroll-hidden mt-2 flex min-h-0 flex-1 items-start overflow-y-auto whitespace-pre-wrap break-words text-left text-sm text-ink-soft transition-colors hover:text-ink"
        >
          {text || <span className="text-ink-faint">点这里记点什么…</span>}
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 时钟

/** 常用时区；键是 IANA 名，值是显示用的城市名 */
const ZONE_OPTIONS = [
  { zone: "Asia/Shanghai", label: "北京" },
  { zone: "Asia/Tokyo", label: "东京" },
  { zone: "Asia/Singapore", label: "新加坡" },
  { zone: "Asia/Dubai", label: "迪拜" },
  { zone: "Europe/London", label: "伦敦" },
  { zone: "Europe/Paris", label: "巴黎" },
  { zone: "Europe/Moscow", label: "莫斯科" },
  { zone: "America/New_York", label: "纽约" },
  { zone: "America/Chicago", label: "芝加哥" },
  { zone: "America/Los_Angeles", label: "洛杉矶" },
  { zone: "Australia/Sydney", label: "悉尼" },
  { zone: "UTC", label: "UTC" },
] as const;

function zoneLabel(zone: string): string {
  const known = ZONE_OPTIONS.find((option) => option.zone === zone);
  if (known) return known.label;
  const city = zone.split("/").pop();
  return city ? city.replace(/_/g, " ") : zone;
}

function zoneTime(zone: string, now: Date): string | null {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    return null;
  }
}

const CHINESE_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

/** 农历日：初一到初十 / 十一到十九 / 二十 / 廿一…都按中文写法 */
function chineseDay(day: number): string {
  if (!Number.isFinite(day) || day < 1 || day > 30) return String(day);
  if (day <= 10) return `初${CHINESE_DIGITS[day]}`;
  if (day < 20) return `十${CHINESE_DIGITS[day - 10]}`;
  if (day === 20) return "二十";
  if (day < 30) return `二十${CHINESE_DIGITS[day - 20]}`;
  return "三十";
}

/** 「农历 丙午年九月十五」；运行时 ICU 不支持中国历法时返回 null（不显示这一行） */
function lunarLabel(tz: string, now: Date): string | null {
  try {
    const parts = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      timeZone: tz,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).formatToParts(now);
    // TS 的 DateTimeFormatPartTypes 还没有收录中国历法的 yearName，按字符串比较
    const yearName = parts.find((part) => (part.type as string) === "yearName")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = Number(parts.find((part) => part.type === "day")?.value);
    if (!yearName || !month || !Number.isFinite(day)) return null;
    return `农历 ${yearName}年${month}${chineseDay(day)}`;
  } catch {
    return null;
  }
}

export function ClockWidget({
  tz,
  config,
  onConfigChange,
}: {
  tz: string;
  config?: DashboardWidgetConfig;
  onConfigChange: ConfigChange;
}) {
  const now = useNow();
  const parts = now ? clockParts(tz, now) : null;
  const [setting, setSetting] = useState(false);
  const [draftLunar, setDraftLunar] = useState(false);
  const [draftZones, setDraftZones] = useState<string[]>([]);

  const zones = config?.zones ?? [];
  const lunar = config?.lunar === true;
  const lunarText = lunar && now ? lunarLabel(tz, now) : null;

  function openSetting() {
    setDraftLunar(lunar);
    setDraftZones(zones);
    setSetting(true);
  }

  function toggleZone(zone: string) {
    setDraftZones((current) => {
      if (current.includes(zone)) return current.filter((item) => item !== zone);
      if (current.length >= CLOCK_MAX_ZONES) return current;
      return [...current, zone];
    });
  }

  function save() {
    onConfigChange({ lunar: draftLunar, zones: draftZones }, true);
    setSetting(false);
  }

  return (
    <div className="dw-clock ac-scroll-hidden flex h-full min-h-0 flex-col overflow-y-auto p-3">
      <div className="my-auto">
        {setting ? (
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={draftLunar}
                onChange={(e) => setDraftLunar(e.target.checked)}
              />
              显示农历
            </label>

            <label className="block text-xs text-ink-faint">
              世界时钟（最多 {CLOCK_MAX_ZONES} 个）
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) toggleZone(e.target.value);
                }}
                disabled={draftZones.length >= CLOCK_MAX_ZONES}
                className="ac-field mt-1 text-sm disabled:opacity-50"
              >
                <option value="">添加城市…</option>
                {ZONE_OPTIONS.filter((option) => !draftZones.includes(option.zone)).map((option) => (
                  <option key={option.zone} value={option.zone}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            {draftZones.length > 0 && (
              <ul className="flex flex-wrap gap-1">
                {draftZones.map((zone) => (
                  <li key={zone}>
                    <button
                      type="button"
                      onClick={() => toggleZone(zone)}
                      className="ac-badge bg-surface text-ink-soft hover:text-high"
                      title="移除"
                    >
                      {zoneLabel(zone)} ×
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setSetting(false)}
                className="text-xs text-ink-faint hover:text-ink"
              >
                取消
              </button>
              <button type="button" onClick={save} className="ac-btn px-3 py-1 text-xs">
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-start justify-between gap-2">
              <p className="dw-clock-time font-display text-3xl font-semibold tabular-nums text-ink">
                {parts ? `${parts.hh}:${parts.mm}:${parts.ss}` : "--:--:--"}
              </p>
              <button
                type="button"
                onClick={openSetting}
                className="shrink-0 text-xs text-ink-faint transition-colors hover:text-primary"
              >
                设置
              </button>
            </div>
            <p className="dw-clock-date mt-1 text-xs text-ink-faint">
              {parts ? parts.dateLabel : "按你的时区显示"}
            </p>
            {lunarText && (
              <p className="dw-clock-lunar mt-0.5 text-xs text-ink-faint">{lunarText}</p>
            )}
            {zones.length > 0 && now && (
              <ul className="dw-clock-zones mt-2 space-y-0.5 border-t border-line pt-2">
                {zones.map((zone) => (
                  <li
                    key={zone}
                    className="flex items-baseline justify-between gap-2 text-xs text-ink-soft"
                  >
                    <span className="truncate">{zoneLabel(zone)}</span>
                    <span className="shrink-0 tabular-nums text-ink">
                      {zoneTime(zone, now) ?? "--:--"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
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
    <div className="dw-countdown flex h-full min-h-0 flex-col justify-center p-3">
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
              <p className="dw-countdown-value mt-1 font-display text-2xl font-semibold tabular-nums text-ink">
                {now ? (target.getTime() - now.getTime() > 0 ? formatRemaining(target.getTime() - now.getTime()) : "已到达") : "计算中…"}
              </p>
              <p className="dw-countdown-target mt-1 text-[11px] text-ink-faint">
                目标 {formatDateTime(tz, target)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-ink-faint">点「设置」定一个目标时间</p>
          )}
        </>
      )}
    </div>
  );
}
