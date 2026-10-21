"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "./modal";

// —— 教程步骤：全部由这份数据驱动 ——
// 以后给新功能加介绍，只需在数组里追加一条：
//   { icon, title, description, tips? }
// description 一句话说清它是什么；tips（可选）列具体怎么操作，界面按要点列表渲染。
// 分页、进度点、翻页按钮自动跟着变，渲染逻辑一行都不用动。
// icon 用 24×24 线性 SVG（stroke 风格，与全站图标一致）。
const TUTORIAL_STEPS: {
  icon: React.ReactNode;
  title: string;
  description: string;
  tips?: string[];
}[] = [
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
        <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
        <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
      </svg>
    ),
    title: "欢迎来到 AgileCampus",
    description:
      "这是面向高校实验室的敏捷协作平台：任务、项目、团队、消息与 AI 助手都在这里。下面几页带你把各模块的基础操作走一遍；之后想回看，就到右上角「设置 → 新手教程」。",
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
    title: "工作台 · 我的任务",
    description: "登录后先到工作台：你手头的事都汇总在这里。",
    tips: [
      "顶部「任务统计」：逾期、今天截止、本周截止、进行中，一眼看清轻重缓急",
      "「我的任务」按 待办 / 进行中 / 已完成 分列，拖动卡片即可改状态",
      "「按项目筛选」只看某个项目；「隐藏已完成」让列表更清爽",
      "「最新动态」汇聚与你相关任务的变动，可标记已读或清除记录",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
        <path d="M20 3v4" />
        <path d="M22 5h-4" />
        <path d="M4 17v2" />
        <path d="M5 18H3" />
      </svg>
    ),
    title: "工作台 · AI 助手",
    description: "工作台里的助手既懂你的任务，也记得你交代的事。",
    tips: [
      "直接问：「我这周有什么要交的？」「当前进度如何？」",
      "交办任务：「把调研拆成任务」——助手拟好草案，你逐条确认后才生效",
      "「我的个人上下文」记下你的背景（如「我在准备中期答辩」），默认项目可见，可切换为仅自己",
      "「助手可看到的历史消息条数」随时调整助手的记忆长度",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
    ),
    title: "我的团队 · 建团队与项目",
    description: "团队把人聚到一起，项目都挂在团队下：先建团队，再在团队里创建项目。",
    tips: [
      "「创建团队」后自动成为管理员；把邀请码发给同学，对方填码「加入团队」即可",
      "进入团队页「创建项目」，填好项目名称、描述与起止日期",
      "管理员可移除成员、增删团队标签；退出团队前需先移交管理员",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M8 7v10" />
        <path d="M16 7v6" />
      </svg>
    ),
    title: "项目 · 任务看板",
    description: "日常协作最频繁的地方：进项目页，把活拆成一张张任务。",
    tips: [
      "「新建任务」填标题、指派人、优先级（低/中/高）、起止日期与标签",
      "「里程碑」区输入标题点「添加」，划分项目阶段，任务可挂到里程碑下",
      "看板支持按状态、里程碑、指派人分组，拖动卡片即改状态",
      "点开任务卡可添加子任务、前置任务（依赖）、附件（单个 ≤10MB）与留言；「动态」记录每一次变更",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <rect x="3" y="6" width="9" height="4" rx="1" />
        <rect x="9" y="14" width="12" height="4" rx="1" />
      </svg>
    ),
    title: "项目 · 多种视图",
    description: "同一份任务清单，项目页右上角可在四种视图间切换。",
    tips: [
      "看板：按列拖拽，管状态",
      "时间线：按日期排布，看排期与截止",
      "关系图：看成员与任务的关联",
      "流程图：看任务间的前置依赖，理清先后顺序",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    title: "团队 · 资源与协作",
    description: "团队页还有资源登记与更多协作入口。",
    tips: [
      "「资源占用」登记服务器、算力等共享资源，结束后点「结束占用」，按时长统计",
      "团队标签全队项目共享一套，打任务时直接选用",
      "成员页可查看每个人的身份（导师/学生）与角色",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      </svg>
    ),
    title: "消息",
    description: "站内私信与群聊都在「消息」，有新消息时导航栏会出现未读角标。",
    tips: [
      "搜索用户名即可发起私信",
      "「创建群聊」起个群名、搜索用户名拉人入群，还能传文件（单个 ≤10MB）",
      "收到入群邀请后在「群聊邀请」里接受或拒绝",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z" />
        <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
      </svg>
    ),
    title: "AI配置 · 个人访问令牌",
    description: "想让 Claude Code 等浏览器外的工具读写站内数据，就生成一把个人访问令牌。",
    tips: [
      "点「生成新令牌」，明文只显示一次，当场复制保存",
      "令牌分「供外部程序写入」与「只读」两种权限",
      "不再使用时记得「撤销」；「我的令牌」里能看到每个令牌的最近使用时间",
    ],
  },
  {
    icon: (
      <svg
        viewBox="0 0 24 24"
        className="h-6 w-6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    title: "设置与帮助",
    description: "右上角齿轮是个人设置中心。",
    tips: [
      "修改信息：头像、用户名、身份（导师/学生）、密码",
      "绑定飞书、时区设置也都在这里",
      "本教程随时可以回看：设置菜单 →「新手教程」",
    ],
  },
];

// 「新手教程」小窗：分页展示上面的步骤，←/→ 也能翻页，进度点可点击跳步。
// 首次登录由顶栏自动弹出一次（见 user-menu.tsx，弹出即标记已看）；
// 之后随时从「设置」菜单重开——此时无「跳过」按钮，翻到哪页都行。
export function TutorialModal({
  firstRun,
  onClose,
}: {
  firstRun: boolean;
  onClose: () => void;
}) {
  const [step, setStep] = useState(0);
  const last = TUTORIAL_STEPS.length - 1;
  const current = TUTORIAL_STEPS[step];

  const go = useCallback((delta: number) => {
    setStep((s) => Math.min(Math.max(s + delta, 0), TUTORIAL_STEPS.length - 1));
  }, []);

  // ←/→ 翻页（Escape 由 Modal 外壳负责）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [go]);

  return (
    <Modal title="新手教程" onClose={onClose}>
      {/* key=step：换步时重挂载，重放 ac-step-in 动画（见 project.css）。
          min-h 取各步里最高的一版，换步时卡壳高度不跳；超高时兜底滚动 */}
      <div
        key={step}
        className="ac-step-in grid min-h-[24rem] max-h-[62vh] place-items-center overflow-y-auto px-6 py-5"
      >
        <div className="grid w-full place-items-center gap-3 text-center">
          <span
            aria-hidden
            className="grid h-12 w-12 place-items-center rounded-field bg-primary-soft text-primary"
          >
            {current.icon}
          </span>
          <h3 className="font-display text-lg font-semibold text-ink">{current.title}</h3>
          <p className="max-w-sm text-sm leading-relaxed text-ink-soft">{current.description}</p>
          {current.tips && (
            <ul className="w-full max-w-sm space-y-1.5 text-left">
              {current.tips.map((tip) => (
                <li key={tip} className="flex gap-2 text-sm leading-relaxed text-ink-soft">
                  <span
                    aria-hidden
                    className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-primary"
                  />
                  {tip}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <footer className="flex min-h-14 items-center justify-between gap-3 border-t border-line px-5 py-3">
        <div className="flex items-center gap-1.5">
          {TUTORIAL_STEPS.map((s, i) => (
            <button
              key={s.title}
              type="button"
              aria-label={`第 ${i + 1} 步：${s.title}`}
              onClick={() => setStep(i)}
              className={`h-2 rounded-full transition-all ${
                i === step ? "w-5 bg-primary" : "w-2 bg-line hover:bg-ink-faint"
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          {firstRun && step < last && (
            <button type="button" onClick={onClose} className="ac-btn-ghost text-sm">
              跳过
            </button>
          )}
          {step > 0 && (
            <button type="button" onClick={() => go(-1)} className="ac-btn-ghost text-sm">
              上一步
            </button>
          )}
          <button
            type="button"
            onClick={() => (step < last ? go(1) : onClose())}
            className="ac-btn text-sm"
          >
            {step < last ? "下一步" : "完成"}
          </button>
        </div>
      </footer>
    </Modal>
  );
}
