"use client";

import { useActionState } from "react";
import {
  addContextAction,
  deleteContextAction,
  toggleContextVisibilityAction,
  type ContextState,
} from "@/app/(app)/dashboard/actions";

/**
 * 我的个人上下文：一张列表 + 一行新增。**嵌在助手卡片的「设置」面板里**渲染
 * （见 `agent-chat.tsx` 的 `settings`），故自带背景与边框由外层给，这里只排内容。
 *
 * 「项目可见」是默认值，因为它意味着**队友可以通过项目助手看到这条**——界面必须说清楚，
 * 否则就是拿别人的信息去换助手的聪明。故每条都挂着可见性徽章（点一下即切换），
 * 新增表单上也有说明。
 */

export interface ContextRow {
  id: string;
  content: string;
  visibility: "shared" | "private";
}

export function PersonalContextCard({ items }: { items: ContextRow[] }) {
  const [state, formAction, pending] = useActionState<ContextState, FormData>(
    addContextAction,
    null,
  );
  const error = state && "error" in state ? state.error : null;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-ink">我的个人上下文</h3>
        <p className="mt-0.5 text-xs text-ink-faint">
          助手据此了解你在做什么；「项目可见」的条目，队友问项目助手时也会看到
        </p>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-ink-soft">
          还没记什么。写一条吧，比如「我在做遥感图像分割，每周三下午有课」——
          也可以直接跟下面的助手说，让它拟好草案你来确认。
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.id} className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="whitespace-pre-wrap text-sm text-ink">{it.content}</p>
                <form action={toggleContextVisibilityAction} className="mt-1">
                  <input type="hidden" name="id" value={it.id} />
                  <input
                    type="hidden"
                    name="visibility"
                    value={it.visibility === "shared" ? "private" : "shared"}
                  />
                  <button
                    type="submit"
                    title="点击切换可见性"
                    className={`ac-badge ${
                      it.visibility === "shared"
                        ? "bg-primary-soft text-primary"
                        : "bg-sunken text-ink-soft"
                    }`}
                  >
                    {it.visibility === "shared" ? "项目可见" : "仅自己"}
                  </button>
                </form>
              </div>
              <form action={deleteContextAction}>
                <input type="hidden" name="id" value={it.id} />
                <button className="ac-btn-ghost text-high hover:border-high hover:text-high">
                  删除
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}

      <form action={formAction} className="space-y-2 border-t border-line pt-3">
        <textarea
          name="content"
          rows={2}
          maxLength={1000}
          placeholder="记录一条背景，如「我在准备中期答辩」"
          className="ac-field text-sm"
        />
        <div className="flex items-center gap-2">
          <select name="visibility" defaultValue="shared" className="ac-field w-auto text-sm">
            <option value="shared">项目可见</option>
            <option value="private">仅自己</option>
          </select>
          <button disabled={pending} className="ac-btn text-sm">
            {pending ? "保存中…" : "记下来"}
          </button>
          {error && <span className="text-sm text-high">{error}</span>}
        </div>
      </form>
    </section>
  );
}
