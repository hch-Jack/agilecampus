/**
 * 助手「记得多少上文」的**纯常量与钳制**——不碰库，故客户端组件也能引（界面要显示上下限）。
 *
 * 与 lib/agent/memory.ts 的分工照抄 lib/time.ts 与 lib/time-pref.ts 那一对：
 * 这边纯函数、两边都算得了；那边要读库，只在服务端用。**别把 `db` 拖进来** ——
 * 一旦这个模块 import 了 `@/db`，客户端组件引它就等于把 postgres 驱动打进浏览器包。
 *
 * 三个常量是唯一真相源：schema 的默认值、memory.ts 的存取、界面的 min/max 都照它们写。
 * （schema 由 drizzle-kit 独立加载、不引应用侧模块，故那边的 `default(10)` 只能是字面量。）
 */

export const AI_HISTORY_LIMIT_MIN = 0;
export const AI_HISTORY_LIMIT_MAX = 50;
export const AI_HISTORY_LIMIT_DEFAULT = 10;

/**
 * 把任意输入钳到合法区间；非数字一律落回默认值（绝不让坏值进库）。
 *
 * 空串单拎出来判：`Number("")` 是 `0`，而「输入框清空了」的意图是恢复默认，不是「一条都不看」。
 * `0` 本身是合法值，故只能靠这个判断把两者分开。
 */
export function normalizeAiHistoryLimit(value: unknown): number {
  const n =
    typeof value === "string"
      ? value.trim() === ""
        ? AI_HISTORY_LIMIT_DEFAULT
        : Number(value)
      : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return AI_HISTORY_LIMIT_DEFAULT;
  const int = Math.trunc(n);
  if (int < AI_HISTORY_LIMIT_MIN) return AI_HISTORY_LIMIT_MIN;
  if (int > AI_HISTORY_LIMIT_MAX) return AI_HISTORY_LIMIT_MAX;
  return int;
}
