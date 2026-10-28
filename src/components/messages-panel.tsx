"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MessagesClient } from "@/app/(app)/messages/messages-client";
import {
  ASSISTANT_PANEL_OPEN_EVENT,
  MESSAGES_PANEL_OPEN_EVENT,
} from "@/lib/right-panels";
import { MessagesPanelContext } from "./messages-panel-context";

/**
 * 主界面右侧的「消息浮窗」——消息系统的第二种形态。
 *
 * 布局口径与 AI 助手面板（assistant-shell.tsx）完全一致：桌面端挤压正文
 * （`lg:pr-[570px]` 加在整页外层）、移动端覆盖 + 遮罩，抽屉同宽（`lg:w-[570px]`）。
 * aside 复用 `assistant-panel` 类，宇宙主题的深色玻璃样式和减弱动态偏好一起生效。
 *
 * 与助手的互斥（不共存）靠 window 事件（见 lib/right-panels.ts），两边互不 import。
 *
 * 内容按需挂载，可见性是**派生**的（`open && 不在消息页`），路由回 /messages
 * （导航点「消息」、浮窗切整页、浏览器后退）时抽屉立即让位给整页，不靠 effect 关：
 * MessagesClient 一挂载就轮询、打开私信即置已读，看不见时留着会在背后把消息置读。
 * 主动收起（Esc/遮罩/切整页）走 closePanel，内容多挂 300ms 播完滑出动画再卸；
 * 切换模式时的会话现场用 sessionStorage 接力（见 messages-client）。
 */
export function MessagesPanelShell({
  timeZone,
  children,
}: {
  /** 用户设置的时区，MessagesClient 的时间显示口径（与消息页同一来源） */
  timeZone: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  // 主动收起后内容再挂 300ms（播完滑出动画）；由 effect 在 open=false 后定时清掉
  const [keepMounted, setKeepMounted] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  // 路由落回 /messages 即视为整页模式：抽屉立刻让位（派生，不是 effect 里 setState）
  const visible = open && pathname !== "/messages";
  const renderContent = visible || keepMounted;

  // 「进消息系统之前的页面」：layout 的客户端组件跨路由常驻，每次落到非消息页记一笔；
  // 直接打开/刷新在 /messages 时没有来路，openAndLeave 兜底去工作台。
  const returnPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (pathname !== "/messages") returnPathRef.current = pathname;
  }, [pathname]);

  // —— 与 AI 助手互斥：我开你收，你开我收 ——
  useEffect(() => {
    if (open) window.dispatchEvent(new Event(MESSAGES_PANEL_OPEN_EVENT));
  }, [open]);
  useEffect(() => {
    const close = () => closePanel();
    window.addEventListener(ASSISTANT_PANEL_OPEN_EVENT, close);
    return () => window.removeEventListener(ASSISTANT_PANEL_OPEN_EVENT, close);
  }, []);

  // 主动收起后，等滑出动画（300ms）播完再卸内容。只在超时回调里 setState。
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setKeepMounted(false), 300);
    return () => clearTimeout(t);
  }, [open]);

  // Escape 收起（只在打开时挂监听）
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // 移动端是覆盖式抽屉：锁住背景滚动；桌面端是并排布局，页面仍需能滚。
  // 记住原值再恢复，别把别的代码写的 overflow 覆盖掉。
  useEffect(() => {
    if (!visible) return;
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
  }, [visible]);

  /** 主动收起：滑出动画期间内容先留着（keepMounted），播完由上面的 effect 卸载 */
  function closePanel() {
    setOpen(false);
    setKeepMounted(true);
  }

  /** 整页 → 浮窗：打开并离开消息页（回到进消息前的页面，兜底工作台） */
  function openAndLeave() {
    setOpen(true);
    router.push(returnPathRef.current ?? "/dashboard");
  }

  /** 浮窗 → 整页：收起并打开整页消息 */
  function expandToPage() {
    closePanel();
    router.push("/messages");
  }

  return (
    <MessagesPanelContext.Provider value={{ open, openAndLeave, expandToPage }}>
      {/* 桌面端挤压正文：与助手的 assistant-shell-push 同款；互斥保证不会同时挤压 */}
      <div
        className={`min-h-screen transition-[padding] duration-300 ease-out ${
          visible ? "lg:pr-[570px]" : ""
        }`}
      >
        {children}
      </div>

      {/* 移动端遮罩；桌面端正文已被挤开，不需要 */}
      {visible && (
        <div
          aria-hidden
          onClick={closePanel}
          className="ac-backdrop-in fixed inset-0 z-30 bg-ink/40 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        id="messages-panel"
        aria-label="消息"
        aria-hidden={!visible}
        inert={!visible}
        className={`assistant-panel fixed inset-y-0 right-0 z-40 flex w-full max-w-[630px] flex-col border-l border-line bg-surface shadow-pop transition-transform duration-300 ease-out lg:w-[570px] ${
          visible ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col p-4 lg:px-5">
          {renderContent && <MessagesClient timeZone={timeZone} variant="panel" />}
        </div>
      </aside>
    </MessagesPanelContext.Provider>
  );
}
