"use client";

import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { MessagesClient } from "@/app/(app)/messages/messages-client";
import { handoffFromMessagesSearch, writeMessagesHandoff } from "@/lib/messages-handoff";
import {
  ASSISTANT_PANEL_OPEN_EVENT,
  MESSAGES_PANEL_OPEN_EVENT,
} from "@/lib/right-panels";
import { MessagesPanelContext, useMessagesPanel, type MessagesMode } from "./messages-panel-context";

/**
 * 消息系统的**固定模式**（整页 ⇄ 右侧浮窗）与浮窗本体。
 *
 * 两种模式不共存、只生效一种：选定后固定，跨导航/刷新保持（localStorage），
 * 只有在消息界面右上角点「切换为浮窗 / 切换为整页」才转变。
 * - page 模式：消息系统就是 /messages 整页（原样）
 * - drawer 模式：消息系统只以右侧浮窗出现——顶栏「消息」按钮开/关它，
 *   导航点「消息」也是开浮窗；落在 /messages（直接输网址/后退/深链）一律
 *   弹回上一个页面（兜底工作台）并开浮窗，整页不让出现
 *
 * 浮窗布局口径与 AI 助手面板（assistant-shell.tsx）完全一致：桌面端挤压正文
 * （`lg:pr-[570px]`）、移动端覆盖 + 遮罩，抽屉同宽（`lg:w-[570px]`）；
 * aside 复用 `assistant-panel` 类拿宇宙主题深色玻璃与减弱动态偏好。
 * 与助手的互斥靠 window 事件（见 lib/right-panels.ts），两边互不 import。
 *
 * 内容**按需挂载**（主动收起后多挂 300ms 播完滑出动画）：MessagesClient 一挂载
 * 就开始 4s 轮询、打开私信即置已读，看不见时留着会在背后把消息置读，所以
 * 不能学助手常驻；模式切换/深链的会话现场用 sessionStorage 接力（lib/messages-handoff.ts）。
 */

const MESSAGES_MODE_STORAGE_KEY = "ac_messages_mode";

// 模式是 localStorage 里的持久偏好：用 useSyncExternalStore 读取（不在 effect 里 setState）。
// 同标签页的 setItem 不触发 storage 事件，所以写入后手动通知一次监听者。
const MODE_LISTENERS = new Set<() => void>();

function subscribeMode(onChange: () => void): () => void {
  MODE_LISTENERS.add(onChange);
  const onStorage = (e: StorageEvent) => {
    if (e.key === MESSAGES_MODE_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    MODE_LISTENERS.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function getModeSnapshot(): MessagesMode {
  try {
    return window.localStorage.getItem(MESSAGES_MODE_STORAGE_KEY) === "drawer"
      ? "drawer"
      : "page";
  } catch {
    return "page";
  }
}

/** SSR 与水合首帧的快照：默认整页，挂载后按存储值重渲染（与教程弹窗同一套路） */
function getServerModeSnapshot(): MessagesMode {
  return "page";
}

function persistMode(next: MessagesMode) {
  try {
    window.localStorage.setItem(MESSAGES_MODE_STORAGE_KEY, next);
  } catch {
    // 存不了就只在本次会话内生效
  }
  MODE_LISTENERS.forEach((cb) => cb());
}

export function MessagesPanelShell({
  timeZone,
  children,
}: {
  /** 用户设置的时区，MessagesClient 的时间显示口径（与消息页同一来源） */
  timeZone: string;
  children: ReactNode;
}) {
  // 默认整页；useSyncExternalStore 挂载后按 localStorage 恢复并保持响应
  const mode = useSyncExternalStore(subscribeMode, getModeSnapshot, getServerModeSnapshot);
  const [open, setOpen] = useState(false);
  // 主动收起后内容再挂 300ms（播完滑出动画）；由 effect 在 open=false 后定时清掉
  const [keepMounted, setKeepMounted] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  // 浮窗可见性是派生的：只在 drawer 模式且不在 /messages 上（后者是跳转过渡态）。
  // 这样两种消息形态天然不共存，也避免「路由回消息页关浮窗」这类 effect 里 setState。
  const visible = mode === "drawer" && open && pathname !== "/messages";
  const renderContent = visible || keepMounted;

  // 「进消息系统之前的页面」：layout 的客户端组件跨路由常驻，每次落到非消息页记一笔；
  // 直接打开/刷新时没有来路，弹回/切换兜底去工作台。
  const returnPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (pathname !== "/messages") returnPathRef.current = pathname;
  }, [pathname]);

  // drawer 模式下落在 /messages（输网址、后退、助手/工作台深链）：整页让位——
  // 把深链参数转成接力交给浮窗，弹回上一个页面并开浮窗。replace 不留垃圾历史。
  // setState 放进 setTimeout 回调：既躲开 react-hooks/set-state-in-effect，
  // 也让清理函数能在依赖翻转时掐掉尚未发生的跳转。
  useEffect(() => {
    if (mode !== "drawer" || pathname !== "/messages") return;
    const t = setTimeout(() => {
      const target = handoffFromMessagesSearch(window.location.search);
      if (target) writeMessagesHandoff(target);
      setOpen(true);
      router.replace(returnPathRef.current ?? "/dashboard");
    }, 0);
    return () => clearTimeout(t);
  }, [mode, pathname, router]);

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
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible]);

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

  /** 按当前模式打开消息系统：page → 跳整页；drawer → 开浮窗 */
  function openMessages() {
    if (mode === "drawer") {
      setOpen(true);
      return;
    }
    router.push("/messages");
  }

  /** drawer 模式下开/关浮窗（顶栏「消息」按钮 / 导航链接共用） */
  function toggleDrawer() {
    if (mode !== "drawer") return;
    if (open) closePanel();
    else setOpen(true);
  }

  /**
   * 切到另一种模式（消息界面右上角按钮），选定即固定：
   * page→drawer：状态翻转后由上面的「落在 /messages」effect 负责弹回上一页并开浮窗；
   * drawer→page：收起浮窗、打开整页。
   */
  function switchMode() {
    if (mode === "page") {
      persistMode("drawer");
      setOpen(true);
    } else {
      persistMode("page");
      closePanel();
      router.push("/messages");
    }
  }

  return (
    <MessagesPanelContext.Provider value={{ mode, open, openMessages, toggleDrawer, switchMode }}>
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

/** 顶栏里的消息开关（AI 助手按钮旁）：page 模式跳整页，drawer 模式开/关浮窗 */
export function MessagesToggle() {
  const panel = useMessagesPanel();
  const pathname = usePathname();
  if (!panel) return null;

  const active = panel.mode === "drawer" ? panel.open : pathname.startsWith("/messages");
  return (
    <button
      type="button"
      aria-label="消息"
      aria-expanded={panel.mode === "drawer" ? panel.open : undefined}
      onClick={() => (panel.mode === "drawer" ? panel.toggleDrawer() : panel.openMessages())}
      className={`ac-btn-ghost inline-flex items-center gap-1.5 ${
        active ? "border-primary bg-primary-soft text-primary" : ""
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
        <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 8.9 8.9 0 0 1-3.8-.9L3 21l1.9-5.4a8.5 8.5 0 1 1 16.1-4.1Z" />
      </svg>
      <span className="hidden sm:inline">消息</span>
    </button>
  );
}
