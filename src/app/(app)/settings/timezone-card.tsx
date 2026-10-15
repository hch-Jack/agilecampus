"use client";

import { useActionState, useEffect, useState } from "react";
import {
  AUTO_TIMEZONE,
  clockParts,
  formatDateTime,
  offsetLabel,
  type TimeZoneOption,
} from "@/lib/time";
import { updateTimeZoneAction, type TimeZoneState } from "./actions";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

export function TimezoneCard({
  pref,
  options,
}: {
  pref: string;
  options: TimeZoneOption[];
}) {
  const [state, formAction, pending] = useActionState<TimeZoneState, FormData>(
    updateTimeZoneAction,
    null,
  );
  // 只存「用户刚选、还没提交」的那个值；真值永远是服务端给的 pref。
  // 这样提交成功后无需任何 effect 去同步：pref 变成用户选的那个，两者自然重合。
  const [picked, setPicked] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  // 惰性初始值而非 effect：它只喂给下面那行预览，而预览在时钟就位前恒不渲染，
  // 所以服务端预渲染阶段这里取到什么值都不影响首屏 HTML，不会有 hydration 失配。
  const [browserTz] = useState<string | null>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      return null;
    }
  });

  // 挂载后再取时钟：服务端预渲染那一刻与本机不一定是同一分钟，
  // 直接把时间渲染进首屏会在 hydration 时对不上。
  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, []);

  const tz = picked ?? pref;
  const effective = tz === AUTO_TIMEZONE ? (browserTz ?? pref) : tz;
  const preview = now ? clockParts(effective, now) : null;

  // id 供顶栏「设置」菜单锚点跳转；scroll-mt 避开 sticky 顶栏
  return (
    <form id="timezone" action={formAction} className="ac-card scroll-mt-20 space-y-3 p-5">
      <h2 className="font-display text-base font-semibold text-ink">时区</h2>
      <p className="text-sm text-ink-soft">
        页面上所有时间都按这个时区显示，「今天」「已逾期」也按它算。默认北京时间。
      </p>

      <label className="block space-y-1">
        <span className="text-xs font-medium text-ink-soft">显示时区</span>
        <select
          name="timezone"
          // 非受控：DOM 自己持有选择值，这里只跟着更新预览与「保存」的可用状态
          defaultValue={pref}
          onChange={(e) => setPicked(e.target.value)}
          className="ac-field text-sm"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {/* 高度先占住，免得挂载后才出现这行字把下面的内容顶下去 */}
      <p className="min-h-5 text-xs text-ink-faint">
        {now && preview && (
          <>
            {tz === AUTO_TIMEZONE ? `跟随浏览器（${effective}）` : offsetLabel(effective, now)}
            ：当前是 {formatDateTime(effective, now)}（周{WEEK[preview.weekday]}）
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending || tz === pref} className="ac-btn text-sm">
          {pending ? "保存中…" : "保存"}
        </button>
        {tz === pref && !pending && <span className="text-xs text-ink-faint">当前设置</span>}
      </div>

      {state?.error && <p className="text-sm text-high">{state.error}</p>}
    </form>
  );
}
