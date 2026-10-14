/**
 * 时区：把「库里存的东西」换算成「用户眼里的时间」。
 *
 * 两条必须守住的规矩（详见 docs/BACKLOG.md 的时区条目）：
 *
 * 1. **只换算时刻，不换算日历日。**
 *    `timestamp` 列（createdAt/updatedAt/startTime…）是一个时刻，按用户时区格式化；
 *    `date` 列（dueDate/targetDate/startDate…）是一个日历日，**没有时区含义** ——
 *    截止日是 9/1 就永远是 9/1，谁都别去动它。要比较就用 `addDays` 在字符串上比。
 *
 * 2. **这里是「读」，不是「写」。** 本模块不碰存储，也不该被用来决定往库里写什么。
 *    （唯一的例外是 `zonedWallClockToInstant`：它把用户在输入框里敲的墙面时间
 *    还原成一个时刻，避免用服务端进程的时区去解析用户的输入。）
 *
 * 本模块是纯函数、不引任何服务端依赖，客户端组件可以放心 import。
 */

export const DEFAULT_TIMEZONE = "Asia/Shanghai";
/** 「跟随浏览器」：真正的时区由 ac_tz cookie 决定，见 lib/time-pref.ts */
export const AUTO_TIMEZONE = "auto";

/**
 * 承载「浏览器时区」的 cookie 名。
 *
 * 定义在这个纯模块里而不是 time-pref.ts —— 客户端组件要读它来比对，
 * 而 time-pref.ts 引了 db 与 next/headers，被客户端碰一下就会把整个服务端依赖图拖进 bundle。
 */
export const TZ_COOKIE = "ac_tz";
export const TZ_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** 纯日历日的形状。所有「这是不是一个 date 列的值」的判断都以此为准。 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 全球最东的时区（UTC+14，基里巴斯）。
 *
 * 用来算「对**所有**时区都成立」的宽松上界：各时区的「明天」不是同一天，
 * 先按最东的那个取上界、再逐个按各人时区精确过筛，才不会漏行。
 * 见 lib/notify.ts 的临期扫描。
 */
export const FARTHEST_EAST_TIMEZONE = "Pacific/Kiritimati";

// --------------------------------------------------------------- 时区名与偏好

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  try {
    // 构造本身就会校验；非法名会抛 RangeError
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 偏好 → 一个确定可用的时区名。
 *
 * 任何取不到 / 不认识的值都退回 `DEFAULT_TIMEZONE`（中国时间）——
 * 用户要的效果就是「默认中国时间」，所以默认值这条路上不该有任何惊喜。
 */
export function resolveTimeZone(
  pref: string | null | undefined,
  browserTz?: string | null,
): string {
  if (pref === AUTO_TIMEZONE) {
    return isValidTimeZone(browserTz) ? browserTz : DEFAULT_TIMEZONE;
  }
  return isValidTimeZone(pref) ? pref : DEFAULT_TIMEZONE;
}

// ------------------------------------------------------------------ Intl 取件

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  let f = formatterCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      // 用 hourCycle 而不是 hour12:false —— 后者在部分 ICU 版本下午夜会给出 "24"
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(tz, f);
  }
  return f;
}

type WallClock = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

/** 某一时刻在给定时区里「钟面上显示什么」 */
function wallClockIn(tz: string, at: Date): WallClock {
  const out: Record<string, string> = {};
  for (const p of zoneFormatter(tz).formatToParts(at)) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/** 该时区在某一时刻的 UTC 偏移（毫秒，东为正） */
function offsetMsAt(tz: string, at: Date): number {
  const w = wallClockIn(tz, at);
  const asUTC = Date.UTC(+w.year, +w.month - 1, +w.day, +w.hour, +w.minute, +w.second);
  // 两侧都截到秒再比：Intl 只给到秒，直接跟带毫秒的时刻相减会渗出毫秒误差
  return asUTC - Math.floor(at.getTime() / 1000) * 1000;
}

// -------------------------------------------------------------------- 格式化

const pad = (s: string) => s.padStart(2, "0");

/** `YYYY-MM-DD`。传旧时刻进去也是它的年-月-日，不是「今天」 */
export function dateIn(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  return `${w.year}-${w.month}-${w.day}`;
}

/**
 * **「今天」的唯一来源。**
 *
 * 判断层（看板的今日/逾期/本周、提醒扫描、AI 快照的「今天是 X」）一律走这里，
 * 别再出现 `toISOString().slice(0,10)`（那是 UTC 的今天，北京时间晚上 8 点后会退回昨天）
 * 或者 `toLocaleDateString("sv-SE")`（那是进程的今天，容器里就是 UTC）。
 */
export function todayIn(tz: string, at: Date = new Date()): string {
  return dateIn(tz, at);
}

/** `YYYY-MM-DD HH:mm` */
export function formatDateTime(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  return `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}`;
}

/** `M/D HH:mm` */
export function formatShortDateTime(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  return `${+w.month}/${w.day} ${w.hour}:${w.minute}`;
}

/** `HH:mm` —— 与 `dateIn` 配合给「当天的消息只报钟点」用（私信列表） */
export function formatClockTime(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  return `${w.hour}:${w.minute}`;
}

/** `M/DD`（甘特图的横轴刻度） */
export function formatDateShort(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  return `${+w.month}/${w.day}`;
}

/** `<input type="datetime-local">` 要的 `YYYY-MM-DDTHH:mm` */
export function formatInputValue(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  return `${w.year}-${w.month}-${w.day}T${w.hour}:${w.minute}`;
}

/** 欢迎页时钟：钟面读数 + 用中文写法的日期 + 星期几（0=周日），外加用于问候语的小时数 */
export function clockParts(tz: string, at: Date) {
  const w = wallClockIn(tz, at);
  return {
    hh: w.hour,
    mm: w.minute,
    ss: w.second,
    hour: +w.hour,
    weekday: weekdayOfDate(`${w.year}-${w.month}-${w.day}`),
    dateLabel: `${+w.year}年${+w.month}月${+w.day}日`,
  };
}

/** 某个日历日是星期几（0=周日）。纯字符串运算，不经过任何时区。 */
export function weekdayOfDate(dateStr: string): number {
  if (!DATE_ONLY.test(dateStr)) {
    throw new Error(`weekdayOfDate 只接受 YYYY-MM-DD，收到：${dateStr}`);
  }
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 时区偏移的中文提示，如 `GMT+8`；设置页的预览行用 */
export function offsetLabel(tz: string, at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  }).formatToParts(at);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
}

// ------------------------------------------------------------ 日历日（date 列）

/**
 * 日历日加减，纯字符串运算 —— **不经过任何时区**。
 * `addDays("2026-12-31", 1)` → `"2027-01-01"`；跨月、跨年、闰日都由 Date.UTC 的溢出规则处理。
 */
export function addDays(dateStr: string, n: number): string {
  if (!DATE_ONLY.test(dateStr)) throw new Error(`addDays 只接受 YYYY-MM-DD，收到：${dateStr}`);
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(String(t.getUTCMonth() + 1))}-${pad(String(t.getUTCDate()))}`;
}

// ---------------------------------------------------------------- 反向换算

const WALL_CLOCK_INPUT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * 把「用户在输入框里敲的墙面时间」还原成时刻。
 *
 * `<input type="datetime-local">` 提交的是**没有时区的**字符串，`new Date("2026-10-14T20:30")`
 * 会按**服务端进程的时区**解析 —— 那是容器时区，不是用户的时区。用户选了 UTC 而机器在 +08 时，
 * 登记「20:30」会落成另一个时刻。故必须明确告诉它这是哪个时区里的 20:30。
 *
 * 两步迭代：先用猜的时刻处的偏移修正，再用修正后那一刻的偏移修一次，
 * 跨夏令时切换日也能落到正确的一侧。
 */
export function zonedWallClockToInstant(tz: string, wallClock: string): Date {
  const m = WALL_CLOCK_INPUT.exec(wallClock.trim());
  if (!m) throw new Error(`无法解析的当地时间：${wallClock}`);
  const [, y, mo, d, h, mi, s] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0));
  let ms = guess - offsetMsAt(tz, new Date(guess));
  ms = guess - offsetMsAt(tz, new Date(ms));
  return new Date(ms);
}

// ------------------------------------------------- 无时区 timestamp 列的读写

/**
 * PG `timestamp without time zone` 列的文本形态：`YYYY-MM-DD HH:mm:ss[.ffffff]`。
 * 小数位是微秒（PG 默认精度），而 JS 的 Date 只到毫秒 —— 只取前 3 位。
 */
const DB_WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;

/**
 * 把库里那串墙面时间按**库会话所在的时区**还原成时刻（`dbTimestamp` 的读方向）。
 *
 * 为什么非要显式给时区：无时区 timestamp 列存的是**钟面读数**，本身不带偏移，
 * 光看数据无从知道它属于哪个时区 —— 同一个 `18:19` 既可能是北京时间也可能是 UTC。
 * 而 PG 的 `now()` 落盘时用的是**会话时区**的钟面，所以只有按会话时区读回来才自洽。
 * 与 `zonedWallClockToInstant` 同一套两步迭代，跨夏令时切换日也落在正确的一侧。
 */
export function dbWallClockToInstant(tz: string, wallClock: string): Date {
  const m = DB_WALL_CLOCK.exec(wallClock.trim());
  if (!m) throw new Error(`无法解析的数据库时间：${wallClock}`);
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = Number((frac ?? "").slice(0, 3).padEnd(3, "0"));
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, ms);
  let t = guess - offsetMsAt(tz, new Date(guess));
  t = guess - offsetMsAt(tz, new Date(t));
  return new Date(t);
}

/**
 * 反向（`dbTimestamp` 的写方向）：把一个时刻写成 tz 时区里的钟面读数。
 *
 * 刻意**不带**偏移量：PG 往无时区 timestamp 列里塞带 `Z` 的串时会**静默丢掉**偏移、
 * 直接取字面量，于是落盘的就成了 UTC 的钟面 —— 那正是「库里一套口径、读回来另一套」的根源。
 * 自己先换算好钟面再交给 PG，写与读就只有一个口径。
 */
export function instantToDbWallClock(tz: string, at: Date): string {
  const w = wallClockIn(tz, at);
  const ms = String(at.getMilliseconds()).padStart(3, "0");
  return `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}:${w.second}.${ms}`;
}

// ------------------------------------------------------------------ 选项表

export type TimeZoneOption = { value: string; label: string };

/**
 * 置顶的几项。中国时间排第一 —— 它是默认值，也是绝大多数用户要的那个。
 */
export const CURATED_TIMEZONES: TimeZoneOption[] = [
  { value: DEFAULT_TIMEZONE, label: "中国标准时间（北京时间，UTC+8）" },
  { value: AUTO_TIMEZONE, label: "跟随浏览器（本机时区，自动）" },
  { value: "UTC", label: "协调世界时（UTC）" },
];

/**
 * 全部选项：置顶三项 + ICU 里的其余时区（IANA 名）。
 *
 * 在**服务端**生成后整份传给客户端 —— 两边各算一次会因 ICU 版本不同而选项不一致，
 * 那正是 hydration 失配最爱的形状。
 */
export function listTimeZones(): TimeZoneOption[] {
  const curated = CURATED_TIMEZONES.map((o) => o.value);
  const all =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [];
  return [
    ...CURATED_TIMEZONES,
    ...all.filter((z) => !curated.includes(z)).map((z) => ({ value: z, label: z })),
  ];
}
