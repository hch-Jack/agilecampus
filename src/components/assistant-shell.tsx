"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { AgentChat, type ChatMessage } from "@/components/agent-chat";
import { projectIdFromPathname } from "@/lib/project-path";

/**
 * 主界面右侧的 AI 助手面板。
 *
 * 布局口径（用户确认）：**桌面端挤压内容** —— 面板常驻右列，正文与顶栏一起变窄；
 * **移动端覆盖** —— 全屏面板 + 遮罩。
 *
 * 三个容易踩的点：
 * 1. 面板必须是 `<header>` 的**兄弟**：顶栏带 backdrop-blur，会成为 fixed 后代的包含块，
 *    抽屉放进去就不再相对视口定位（顶栏的「设置」弹窗因此 portal 到 body）。
 * 2. `lg:pr-[380px]` 加在**整页外层**，不能加在 `mx-auto max-w-5xl` 的内容盒上 ——
 *    加在内容盒里会让正文在剩余区域里不居中，顶栏右侧按钮也会被抽屉盖住。
 * 3. 抽屉**常驻挂载**，收起时移出视口（translate + inert）。若按需卸载，`AgentChat` 的
 *    `useState(initialMessages)` 会在下次打开时重新播种，这段时间里发的消息就丢了。
 *
 * 当前项目从 pathname 推：服务端 layout 拿不到路由，客户端 `usePathname()` 可以。
 */

type AssistantUi = { open: boolean; setOpen: (open: boolean) => void };

const AssistantUiContext = createContext<AssistantUi | null>(null);

export function AssistantShell({
  initialMessages,
  children,
}: {
  /** 个人会话历史的一次性种子；之后的轮次由 AgentChat 自己维护 */
  initialMessages: ChatMessage[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const focusProjectId = projectIdFromPathname(usePathname());

  // Escape 收起（只在打开时挂监听，省得每页都挂一个空监听）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // 移动端是覆盖式抽屉：锁住背景滚动；桌面端是并排布局，页面仍需能滚。
  // 记住原值再恢复，别把别的代码写的 overflow 覆盖掉。
  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const previous = document.body.style.overflow;
    const apply = () => {
      document.body.style.overflow = mq.matches ? "hidden" : previous;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => {
      mq.removeEventListener("change", apply);
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <AssistantUiContext.Provider value={{ open, setOpen }}>
      <div
        className={`assistant-shell-push min-h-screen transition-[padding] duration-300 ease-out ${
          open ? "lg:pr-[380px]" : ""
        }`}
      >
        {children}
      </div>

      {/* 移动端遮罩；桌面端正文已被挤开，不需要 */}
      {open && (
        <div
          aria-hidden
          onClick={() => setOpen(false)}
          className="ac-backdrop-in fixed inset-0 z-30 bg-ink/40 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        id="assistant-panel"
        aria-label="AI 助手"
        aria-hidden={!open}
        inert={!open}
        className={`assistant-panel fixed inset-y-0 right-0 z-40 flex w-full max-w-[420px] flex-col border-l border-line bg-surface shadow-pop transition-transform duration-300 ease-out lg:w-[380px] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="min-h-0 flex-1 p-4">
          <AgentChat
            scope="personal"
            projectId={focusProjectId ?? undefined}
            initialMessages={initialMessages}
            subtitle={
              focusProjectId ? "只属于你的对话 · 已带入当前项目" : "只属于你的对话"
            }
            emptyHint="问我手上任意项目的事。在项目页面里，我会自动带上当前项目的动态、留言与任务。"
            placeholder="问点什么，或交代一句让我记住…"
            actions={
              <>
                <Link href="/settings" className="ac-btn-ghost text-xs">
                  设置
                </Link>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="收起助手"
                  className="grid h-7 w-7 place-items-center rounded-field text-ink-faint transition-colors hover:bg-sunken hover:text-ink"
                >
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    aria-hidden
                  >
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </>
            }
          />
        </div>
      </aside>
    </AssistantUiContext.Provider>
  );
}

/** 顶栏里的开关。按钮在 layout 的服务端子树里，靠 context 连到 AssistantShell。 */
export function AssistantToggle() {
  const ui = useContext(AssistantUiContext);
  if (!ui) return null;

  return (
    <button
      type="button"
      aria-label="AI 助手"
      aria-expanded={ui.open}
      aria-controls="assistant-panel"
      onClick={() => ui.setOpen(!ui.open)}
      className={`ac-btn-ghost inline-flex items-center gap-1.5 ${
        ui.open ? "border-primary bg-primary-soft text-primary" : ""
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-4 w-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M12 3l1.8 4.9 4.9 1.8-4.9 1.8L12 16.4l-1.8-4.9L5.3 9.7l4.9-1.8L12 3Z" />
        <path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
      </svg>
      <span className="hidden sm:inline">AI 助手</span>
    </button>
  );
}
