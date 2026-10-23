"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AgentChat, type ChatMessage } from "@/components/agent-chat";
import { AssistantConversations } from "@/components/assistant-conversations";
import {
  ASSISTANT_CONVERSATION_COOKIE,
  ASSISTANT_COOKIE_MAX_AGE,
  ASSISTANT_RESET_EVENT,
  type AssistantConversationSummary,
} from "@/lib/agent/assistant-panel-shared";
import { projectIdFromPathname } from "@/lib/project-path";

/**
 * 主界面右侧的 AI 助手面板。
 *
 * 布局口径（用户确认）：**桌面端挤压内容** —— 面板常驻右列，正文与顶栏一起变窄；
 * **移动端覆盖** —— 全屏面板 + 遮罩。
 *
 * 四个容易踩的点：
 * 1. 面板必须是 `<header>` 的**兄弟**：顶栏带 backdrop-blur，会成为 fixed 后代的包含块，
 *    抽屉放进去就不再相对视口定位（顶栏的「设置」弹窗因此 portal 到 body）。
 * 2. `lg:pr-[570px]` 加在**整页外层**，不能加在 `mx-auto max-w-5xl` 的内容盒上 ——
 *    加在内容盒里会让正文在剩余区域里不居中，顶栏右侧按钮也会被抽屉盖住。
 *    **这个数与抽屉的 `lg:w-[570px]` 必须一致**，改宽度时两处一起改。
 * 3. 抽屉**常驻挂载**，收起时移出视口（translate + inert）。若按需卸载，`AgentChat` 的
 *    `useState(initialMessages)` 会在下次打开时重新播种，这段时间里发的消息就丢了。
 * 4. `viewKey` 只在**显式切换/新建/删除当前会话/重置**时递增，用来重新播种 `AgentChat`。
 *    发送时后端替「还没有会话」的用户懒建一条，这种情况**不能**递增 —— 否则刚发出去的消息
 *    连同输入框会一起被 remount 掉。
 *
 * 当前项目从 pathname 推：服务端 layout 拿不到路由，客户端 `usePathname()` 可以。
 * 会话列表放在正常文档流里：抽屉带 transform，宇宙主题还有 backdrop-filter，
 * 面板内不能用 absolute/fixed 弹层。
 */

type AssistantUi = { open: boolean; setOpen: (open: boolean) => void };

const AssistantUiContext = createContext<AssistantUi | null>(null);

function activityTime(c: AssistantConversationSummary): number {
  return Date.parse(c.lastMessageAt ?? c.createdAt);
}

/** 「最近用过」在前；同一时刻按创建时间、id 兜底，保证顺序稳定 */
function sortConversations(
  list: AssistantConversationSummary[],
): AssistantConversationSummary[] {
  return [...list].sort((a, b) => {
    const byActivity = activityTime(b) - activityTime(a);
    if (byActivity !== 0) return byActivity;
    const byCreated = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    if (byCreated !== 0) return byCreated;
    return b.id.localeCompare(a.id);
  });
}

function upsertConversation(
  list: AssistantConversationSummary[],
  incoming: AssistantConversationSummary,
): AssistantConversationSummary[] {
  return sortConversations([...list.filter((c) => c.id !== incoming.id), incoming]);
}

/** cookie 只是「上次看的是哪条」的提示，服务端会校验归属；uuid 本身不敏感 */
function rememberConversation(id: string | null) {
  document.cookie = id
    ? `${ASSISTANT_CONVERSATION_COOKIE}=${id}; path=/; max-age=${ASSISTANT_COOKIE_MAX_AGE}; samesite=lax`
    : `${ASSISTANT_CONVERSATION_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

export function AssistantShell({
  initialConversations,
  initialActiveId,
  initialMessages,
  children,
}: {
  /** 会话列表（服务端按最近活动排好） */
  initialConversations: AssistantConversationSummary[];
  /** 上次看的那条；没有会话时为 null */
  initialActiveId: string | null;
  /** 当前会话最近 200 条消息的一次性种子；之后由 AgentChat 自己维护 */
  initialMessages: ChatMessage[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const focusProjectId = projectIdFromPathname(usePathname());

  const [conversations, setConversations] = useState(initialConversations);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const [seedMessages, setSeedMessages] = useState<ChatMessage[]>(initialMessages);
  const [viewKey, setViewKey] = useState(0);
  /** AgentChat 里有请求在飞（发送/删除）——此时禁止切会话 */
  const [sessionBusy, setSessionBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  /** 切换请求的递增序号：慢响应回来时若已过期就丢弃 */
  const switchSeq = useRef(0);
  /** 当前 AgentChat 的 viewKey；用来丢弃「重置前发出的请求」晚到的落库回调 */
  const viewKeyRef = useRef(viewKey);
  useEffect(() => {
    viewKeyRef.current = viewKey;
  }, [viewKey]);

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

  // 设置页重置聊天记录后，面板（常驻挂载）靠这个事件跟着清空 ——
  // layout 的服务端 props 变了不会重新播种已有 useState。
  useEffect(() => {
    const onReset = () => {
      switchSeq.current += 1;
      setConversations([]);
      setSeedMessages([]);
      setActiveId(null);
      setViewKey((k) => k + 1);
      setSessionBusy(false);
      setSwitching(false);
      setSwitchError(null);
      rememberConversation(null);
    };
    window.addEventListener(ASSISTANT_RESET_EVENT, onReset);
    return () => window.removeEventListener(ASSISTANT_RESET_EVENT, onReset);
  }, []);

  /** 把一条会话的内容装进 AgentChat（只由显式切换/新建/删除当前会话调用） */
  function applyConversation(id: string, messages: ChatMessage[]) {
    setSeedMessages(messages);
    setActiveId(id);
    setViewKey((k) => k + 1);
    rememberConversation(id);
  }

  async function selectConversation(id: string) {
    if (sessionBusy || switching || id === activeId) return;
    const seq = ++switchSeq.current;
    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch(`/api/chat/conversations/${id}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "加载对话失败");
      if (seq !== switchSeq.current) return;
      if (data.conversation) {
        setConversations((prev) => upsertConversation(prev, data.conversation));
      }
      applyConversation(id, Array.isArray(data.messages) ? data.messages : []);
    } catch (e) {
      if (seq === switchSeq.current) {
        setSwitchError(e instanceof Error ? e.message : "加载对话失败");
      }
    } finally {
      if (seq === switchSeq.current) setSwitching(false);
    }
  }

  async function createConversation() {
    if (sessionBusy || switching) return;
    const seq = ++switchSeq.current;
    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch("/api/chat/conversations", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "新建对话失败");
      if (seq !== switchSeq.current) return;

      const conv = data.conversation as AssistantConversationSummary;
      setConversations((prev) => upsertConversation(prev, conv));
      // 后端可能复用了当前这条空会话：此时保持现场（包括还没发出的输入）
      if (conv.id !== activeId) {
        applyConversation(conv.id, []);
      } else {
        rememberConversation(conv.id);
      }
    } catch (e) {
      if (seq === switchSeq.current) {
        setSwitchError(e instanceof Error ? e.message : "新建对话失败");
      }
    } finally {
      if (seq === switchSeq.current) setSwitching(false);
    }
  }

  /**
   * 发送后后端返回会话信息；懒建的会话在这里进列表，但**不动** viewKey。
   *
   * `sourceView` 是发起这一轮时 AgentChat 的 viewKey：设置页重置会递增 viewKey 并清空列表，
   * 若这时旧请求晚到成功回调，不能把已删的会话又「复活」进列表。
   */
  function handleTurnPersisted(
    info: {
      conversationId: string;
      conversationTitle: string | null;
      conversationCreatedAt: string;
      lastMessageAt: string;
    },
    sourceView: number,
  ) {
    if (sourceView !== viewKeyRef.current) return;
    setConversations((prev) =>
      upsertConversation(prev, {
        id: info.conversationId,
        title: info.conversationTitle,
        createdAt: info.conversationCreatedAt,
        lastMessageAt: info.lastMessageAt,
      }),
    );
    setActiveId((prev) => prev ?? info.conversationId);
    rememberConversation(info.conversationId);
  }

  function handleTurnDeleted(info: {
    conversationId: string;
    lastMessageAt: string | null;
  }) {
    setConversations((prev) =>
      sortConversations(
        prev.map((c) =>
          c.id === info.conversationId
            ? { ...c, lastMessageAt: info.lastMessageAt }
            : c,
        ),
      ),
    );
  }

  async function renameConversation(id: string, title: string): Promise<string | null> {
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return data.error ?? "改名失败";
      if (data.conversation) {
        setConversations((prev) => upsertConversation(prev, data.conversation));
      }
      return null;
    } catch {
      return "网络异常，请重试";
    }
  }

  /** 确认弹窗在列表组件里（它知道标题）；这里只负责请求与切到相邻会话 */
  async function deleteConversation(id: string) {
    if (sessionBusy || switching) return;
    const seq = ++switchSeq.current;
    setSwitching(true);
    setSwitchError(null);
    try {
      const res = await fetch(`/api/chat/conversations/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSwitchError(data.error ?? "删除失败");
        return;
      }

      const remaining = sortConversations(conversations.filter((c) => c.id !== id));
      setConversations(remaining);

      // 删的不是当前会话：列表更新即可，别的都不动
      if (id !== activeId) return;

      const next = remaining[0];
      if (!next) {
        setSeedMessages([]);
        setActiveId(null);
        setViewKey((k) => k + 1);
        rememberConversation(null);
        return;
      }

      // 优先切到最近用过的下一条；取不到就退回空态，至少别显示已删的内容
      const nextRes = await fetch(`/api/chat/conversations/${next.id}`);
      const nextData = await nextRes.json().catch(() => ({}));
      if (seq !== switchSeq.current) return;
      if (!nextRes.ok) {
        setSwitchError(nextData.error ?? "加载对话失败");
        setSeedMessages([]);
        setActiveId(null);
        setViewKey((k) => k + 1);
        rememberConversation(null);
        return;
      }
      if (nextData.conversation) {
        setConversations((prev) => upsertConversation(prev, nextData.conversation));
      }
      applyConversation(next.id, Array.isArray(nextData.messages) ? nextData.messages : []);
    } catch {
      if (seq === switchSeq.current) setSwitchError("网络异常，请重试");
    } finally {
      if (seq === switchSeq.current) setSwitching(false);
    }
  }

  return (
    <AssistantUiContext.Provider value={{ open, setOpen }}>
      <div
        className={`assistant-shell-push min-h-screen transition-[padding] duration-300 ease-out ${
          open ? "lg:pr-[570px]" : ""
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
        className={`assistant-panel fixed inset-y-0 right-0 z-40 flex w-full max-w-[630px] flex-col border-l border-line bg-surface shadow-pop transition-transform duration-300 ease-out lg:w-[570px] ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
          <AssistantConversations
            conversations={conversations}
            activeId={activeId}
            busy={sessionBusy || switching}
            onSelect={(id) => void selectConversation(id)}
            onNew={() => void createConversation()}
            onRename={renameConversation}
            onDelete={(id) => void deleteConversation(id)}
          />
          {switchError && <p className="shrink-0 text-sm text-high">{switchError}</p>}
          <div className="min-h-0 flex-1">
            <AgentChat
              key={viewKey}
              scope="personal"
              projectId={focusProjectId ?? undefined}
              conversationId={activeId ?? undefined}
              initialMessages={seedMessages}
              disabled={switching}
              onBusyChange={setSessionBusy}
              onTurnPersisted={(info) => handleTurnPersisted(info, viewKey)}
              onTurnDeleted={handleTurnDeleted}
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
