"use client";

import { useActionState } from "react";
import {
  createSkillAction,
  deleteSkillAction,
  toggleSkillAction,
  updateSkillAction,
  uploadSkillAction,
  type SkillState,
} from "@/app/(app)/settings/skill-actions";

/**
 * 「AI配置 → 技能」：内置技能只读列表 + 导入 / 手写 / 编辑 / 启停 / 删除。
 *
 * 技能是给助手看的**工作流说明**（SKILL.md 正文），不是可执行插件：
 * 导入包里的脚本会原样保存但永不执行，界面上也把这一点说清楚，
 * 免得用户以为上传一个 scripts/ 目录就能跑代码。
 */

export interface BuiltinSkillRow {
  name: string;
  description: string;
}

export interface UserSkillRow {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: "manual" | "agent" | "import";
  origin: string | null;
  enabled: boolean;
}

const ORIGIN_LABEL: Record<string, string> = {
  claude: "Claude Skill",
  markdown: "Markdown",
  json: "JSON 提示词包",
  agilecampus: "内置",
};

const SOURCE_LABEL: Record<UserSkillRow["source"], string> = {
  manual: "手写",
  agent: "助手创建",
  import: "导入",
};

export function SkillManager({
  builtin,
  skills,
}: {
  builtin: BuiltinSkillRow[];
  skills: UserSkillRow[];
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-ink-faint">
          技能是一段「这类任务该怎么做」的工作流说明。助手只在任务与描述吻合时读取它，
          不会每轮都占用上下文。你可以导入 Claude 的 SKILL.md 包，也可以粘贴 OpenAI / DeepSeek
          风格的 Markdown 或 JSON 提示词；助手还能在对话里用 create_skill 替你拟一份。
          技能只属于你个人，不会进入团队共享的项目助手。
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-ink-soft">内置技能</p>
        <ul className="divide-y divide-line rounded-field border border-line">
          {builtin.map((s) => (
            <li key={s.name} className="flex items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-ink">
                  <span className="font-mono text-xs text-ink-soft">{s.name}</span>
                  <span className="ml-2 text-xs text-ink-faint">内置</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-soft">{s.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <UploadForm />
        <CreateForm />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-ink-soft">
          我的技能（{skills.length}）
        </p>
        {skills.length === 0 ? (
          <p className="text-sm text-ink-soft">
            还没有自己的技能。导入一个 SKILL.md 包，或在上面手写一份；
            也可以直接跟右侧助手说「把刚才这套做法做成技能」。
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-field border border-line">
            {skills.map((s) => (
              <SkillItem key={s.id} skill={s} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function UploadForm() {
  const [state, formAction, pending] = useActionState<SkillState, FormData>(
    uploadSkillAction,
    null,
  );
  return (
    <form action={formAction} className="ac-card space-y-2 p-4">
      <p className="text-sm font-medium text-ink">导入技能包</p>
      <p className="text-xs text-ink-faint">
        支持 .zip（内含 SKILL.md，可带 references/ 等文本资料）、单个 .md 或 .json。
        脚本会被保存但不会执行；图片等二进制资料会被跳过。单包最大 2 MB。
      </p>
      <input
        type="file"
        name="skillFile"
        accept=".zip,.md,.markdown,.json,.txt,text/markdown,application/zip,application/json"
        className="block w-full text-xs text-ink-soft file:mr-2 file:rounded-field file:border file:border-line file:bg-sunken file:px-2 file:py-1 file:text-xs file:text-ink"
        aria-label="选择技能文件"
      />
      <button disabled={pending} className="ac-btn px-3 py-1.5 text-sm">
        {pending ? "导入中…" : "导入"}
      </button>
      <StateMessage state={state} />
    </form>
  );
}

function CreateForm() {
  const [state, formAction, pending] = useActionState<SkillState, FormData>(
    createSkillAction,
    null,
  );
  return (
    <details className="ac-card p-4">
      <summary className="cursor-pointer text-sm font-medium text-ink">
        手写一个新技能
      </summary>
      <form action={formAction} className="mt-2 space-y-2">
        <input
          name="name"
          required
          maxLength={64}
          placeholder="名称，如 code-review"
          className="ac-field w-full text-sm"
        />
        <input
          name="description"
          required
          maxLength={300}
          placeholder="一句话说明何时该用（助手靠它判断）"
          className="ac-field w-full text-sm"
        />
        <textarea
          name="instructions"
          required
          rows={6}
          placeholder="工作流正文：步骤、检查项、输出格式……"
          className="ac-field w-full text-sm"
        />
        <button disabled={pending} className="ac-btn px-3 py-1.5 text-sm">
          {pending ? "保存中…" : "创建"}
        </button>
        <StateMessage state={state} />
      </form>
    </details>
  );
}

function SkillItem({ skill }: { skill: UserSkillRow }) {
  return (
    <li className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-ink">
            <span className="font-mono text-xs text-ink-soft">{skill.name}</span>
            <span className="ml-2 rounded bg-sunken px-1.5 py-0.5 text-[10px] text-ink-faint">
              {SOURCE_LABEL[skill.source]}
            </span>
            {skill.origin && skill.origin !== "agilecampus" && (
              <span className="ml-1 rounded bg-sunken px-1.5 py-0.5 text-[10px] text-ink-faint">
                {ORIGIN_LABEL[skill.origin] ?? skill.origin}
              </span>
            )}
            {!skill.enabled && (
              <span className="ml-1 rounded bg-medium-soft px-1.5 py-0.5 text-[10px] text-medium">
                已停用
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-ink-soft">{skill.description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <form action={toggleSkillAction}>
            <input type="hidden" name="id" value={skill.id} />
            <input type="hidden" name="enabled" value={skill.enabled ? "false" : "true"} />
            <button className="ac-btn-ghost px-2 py-1 text-xs">
              {skill.enabled ? "停用" : "启用"}
            </button>
          </form>
          <form
            action={deleteSkillAction}
            onSubmit={(e) => {
              if (!window.confirm(`删除技能「${skill.name}」？此操作不可撤销。`))
                e.preventDefault();
            }}
          >
            <input type="hidden" name="id" value={skill.id} />
            <button className="ac-btn-ghost px-2 py-1 text-xs text-high hover:border-high hover:text-high">
              删除
            </button>
          </form>
        </div>
      </div>

      <details>
        <summary className="cursor-pointer text-xs text-ink-faint">
          查看正文 / 编辑
        </summary>
        <div className="mt-2 space-y-2">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-field bg-sunken p-2 text-xs text-ink">
            {skill.instructions}
          </pre>
          <SkillEditForm skill={skill} />
        </div>
      </details>
    </li>
  );
}

function SkillEditForm({ skill }: { skill: UserSkillRow }) {
  const [state, formAction, pending] = useActionState<SkillState, FormData>(
    updateSkillAction,
    null,
  );
  return (
    <form action={formAction} className="space-y-2 border-t border-line pt-2">
      <input type="hidden" name="id" value={skill.id} />
      <input
        name="name"
        required
        maxLength={64}
        defaultValue={skill.name}
        className="ac-field w-full text-sm"
        aria-label="技能名称"
      />
      <input
        name="description"
        required
        maxLength={300}
        defaultValue={skill.description}
        className="ac-field w-full text-sm"
        aria-label="技能描述"
      />
      <textarea
        name="instructions"
        required
        rows={8}
        defaultValue={skill.instructions}
        className="ac-field w-full text-sm"
        aria-label="技能正文"
      />
      <button disabled={pending} className="ac-btn px-3 py-1.5 text-sm">
        {pending ? "保存中…" : "保存修改"}
      </button>
      <StateMessage state={state} />
    </form>
  );
}

function StateMessage({ state }: { state: SkillState }) {
  if (!state) return null;
  if ("error" in state) return <p className="text-xs text-high">{state.error}</p>;
  if ("ok" in state) return <p className="text-xs text-done">{state.message}</p>;
  return null;
}
