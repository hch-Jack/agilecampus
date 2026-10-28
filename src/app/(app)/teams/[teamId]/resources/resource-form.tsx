"use client";

import { useActionState, useRef } from "react";
import { formatInputValue } from "@/lib/time";
import { createResourceAction, type FormState } from "./actions";

// 当前时间 → datetime-local 所需的 "YYYY-MM-DDTHH:mm"。
// 必须按**用户选的时区**写，不能用浏览器本地的 getHours()：
// 用户把时区设成 UTC 而人在 +08 时，那个「此刻」按钮会填出错的读数，
// 提交后由服务端按同一时区解析，于是登记的时刻也跟着错。
function nowInZone(timeZone: string): string {
  return formatInputValue(timeZone, new Date());
}

export function ResourceForm({
  teamId,
  timeZone,
  needsApproval,
}: {
  teamId: string;
  timeZone: string;
  // 服务端按成员角色算好：学生登记要走审批，老师/管理员登记即生效
  needsApproval: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createResourceAction,
    null,
  );
  const startRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLInputElement>(null);

  return (
    <form action={formAction} className="ac-card space-y-4 p-5">
      <input type="hidden" name="teamId" value={teamId} />
      <div className="flex items-center justify-between">
        <h2 className="font-display text-base font-semibold text-ink">登记资源占用</h2>
        <span className="text-xs text-ink-faint">
          {needsApproval ? "无审核权 · 登记后待审批" : "你有审核权 · 登记后立即生效"}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-soft">资源名称</span>
          <input name="resourceName" placeholder="如 GPU-01 / 服务器A / 示波器" className="ac-field" />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-soft">用途（选填）</span>
          <input name="purpose" placeholder="如 训练模型 / 采集数据" className="ac-field" />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-soft">开始时间</span>
          <div className="flex gap-2">
            <input ref={startRef} name="startTime" type="datetime-local" className="ac-field" />
            <button
              type="button"
              onClick={() => startRef.current && (startRef.current.value = nowInZone(timeZone))}
              className="ac-btn-ghost whitespace-nowrap"
            >
              此刻
            </button>
          </div>
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium text-ink-soft">结束时间（留空 = 占用中）</span>
          <div className="flex gap-2">
            <input ref={endRef} name="endTime" type="datetime-local" className="ac-field" />
            <button
              type="button"
              onClick={() => endRef.current && (endRef.current.value = nowInZone(timeZone))}
              className="ac-btn-ghost whitespace-nowrap"
            >
              此刻
            </button>
          </div>
        </label>
      </div>

      {state?.error && <p className="text-sm text-high">{state.error}</p>}
      {state?.message && <p className="text-sm text-done">{state.message}</p>}

      <button disabled={pending} className="ac-btn">
        {pending ? "提交中…" : needsApproval ? "申请占用" : "登记占用"}
      </button>
    </form>
  );
}
