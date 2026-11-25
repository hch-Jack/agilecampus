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
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </svg>
    ),
    title: "工作台",
    description: "登录后的总览：任务、附件与动态都在这里。",
    tips: [
      "顶部统计一眼看清逾期/今天/本周；看板拖动卡片即可改状态",
      "「按项目筛选」「隐藏已完成」整理视图，右上角可查审批记录",
      "最近附件点文件名直接预览，点文件夹按钮回到所在任务",
    ],
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    title: "团队与项目",
    description: "先把人聚到团队，再在团队里建项目和任务。",
    tips: [
      "创建团队后把邀请码发给同学；管理员可管理成员与标签",
      "项目页支持看板 / 时间线 / 关系图 / 流程图四种视图",
      "任务可加子任务、前置依赖、附件（单个 ≤1GB）与留言",
    ],
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      </svg>
    ),
    title: "资源库与在线编辑",
    description: "任务、私信、群聊和助手文件都会汇总到资源库。",
    tips: [
      "上传可选个人/团队库与目标文件夹；支持搜索、类型筛选与排序",
      "同名文件合并版本，可预览、恢复历史版本、查看操作日志",
      "Word/Excel/PPT 可在线编辑；「AI 编辑」生成待确认修改，保存需手动确认",
    ],
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
      </svg>
    ),
    title: "消息与 AI 助手",
    description: "私信、群聊与 AI 助手都在顶栏。",
    tips: [
      "消息支持私信、群聊与群文件；群文件可同步到个人/团队资源库",
      "AI 助手能查项目/任务、起草草案，草案确认后才生效",
    ],
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    title: "设置",
    description: "右上角齿轮里管理个人设置。",
    tips: [
      "改头像/昵称/密码、绑飞书、设时区",
      "可关闭「登录后显示欢迎页」，也可随时回看本教程",
      "外部工具接入用「个人访问令牌」，不用时及时撤销",
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
              className={`ac-dot-hit relative h-2 rounded-full transition-all ${
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
