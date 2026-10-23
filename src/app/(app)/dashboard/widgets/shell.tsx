import type { ReactNode } from "react";
import Link from "next/link";

/**
 * 卡片内容的统一骨架：标题行 + 撑满剩余高度的正文。
 * （「最新记录」自带操作按钮与标题，直接复用 ActivityFeed 的 embedded 模式。）
 */
export function WidgetShell({
  title,
  href,
  hrefLabel = "查看全部",
  children,
  scroll = true,
}: {
  title: string;
  href?: string;
  hrefLabel?: string;
  children: ReactNode;
  /** false 时正文自己撑满（统计、个人小工具），不套滚动容器 */
  scroll?: boolean;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <h2 className="font-display text-sm font-semibold text-ink">{title}</h2>
        {href && (
          <Link
            href={href}
            className="shrink-0 text-xs text-ink-faint transition-colors hover:text-primary"
          >
            {hrefLabel}
          </Link>
        )}
      </div>
      <div
        className={
          scroll
            ? "mt-2 min-h-0 flex-1 overflow-y-auto pr-1"
            : "mt-2 flex min-h-0 flex-1 flex-col"
        }
      >
        {children}
      </div>
    </div>
  );
}

export function WidgetEmpty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-ink-faint">{children}</p>;
}
