"use client";

import {
  DASHBOARD_WIDGETS,
  WIDGET_IDS,
  isRepeatableWidgetId,
  type DashboardLayoutDoc,
  type DashboardWidgetId,
} from "@/lib/dashboard-layout";

/**
 * 「添加卡片」面板：单例卡只列当前布局里没有的；可重复卡（便签/时钟/倒计时）永远可加。
 */
export function WidgetLibrary({
  layout,
  onAdd,
  onClose,
}: {
  layout: DashboardLayoutDoc;
  onAdd: (type: DashboardWidgetId) => void;
  onClose: () => void;
}) {
  const present = new Set(layout.items.map((item) => item.type));
  const missing = WIDGET_IDS.filter((type) => isRepeatableWidgetId(type) || !present.has(type));

  return (
    <section className="ac-card p-4" aria-label="可添加的卡片">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-semibold text-ink">添加卡片</h2>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            新卡会放在下方，可再拖动到想要的位置
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-ink-faint transition-colors hover:text-ink"
        >
          收起
        </button>
      </div>

      {missing.length === 0 ? (
        <p className="mt-3 text-sm text-ink-faint">所有卡片都已添加。</p>
      ) : (
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {missing.map((type) => {
            const meta = DASHBOARD_WIDGETS[type];
            return (
              <li key={type}>
                <button
                  type="button"
                  onClick={() => onAdd(type)}
                  className="h-full w-full rounded-lg border border-line bg-surface px-3 py-2 text-left transition-colors hover:border-primary/60 hover:bg-primary-soft/40"
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm font-medium text-ink">{meta.title}</span>
                    <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">
                      {isRepeatableWidgetId(type) ? "可重复 · " : ""}
                      {meta.defaultSize.w}×{meta.defaultSize.h}
                    </span>
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-ink-faint">
                    {meta.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
