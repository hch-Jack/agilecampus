import { describe, it, expect } from "vitest";
import { users } from "@/db/schema";
import {
  DEFAULT_TIMEZONE,
  addDays,
  clockParts,
  dateIn,
  formatDateShort,
  formatDateTime,
  formatInputValue,
  formatShortDateTime,
  isValidTimeZone,
  listTimeZones,
  offsetLabel,
  resolveTimeZone,
  todayIn,
  zonedWallClockToInstant,
} from "@/lib/time";

// 本文件是纯函数测试：不连库、不碰网络。
// 它是「所有时间改成中国时间」这一役的主要防线 —— 线上那个 bug 的成因
// （容器跑在 UTC）在本地开发机上复现不出来，只能靠这里把边界钉死。

describe("dateIn / todayIn", () => {
  it("同一刻在上海与 UTC 可以分属两天 —— 线上错位的根因", () => {
    const at = new Date("2026-10-14T17:00:00Z");
    expect(dateIn("Asia/Shanghai", at)).toBe("2026-10-15");
    expect(dateIn("UTC", at)).toBe("2026-10-14");
  });

  it("北京时间的午夜正好落在 UTC 16:00（前后各取一秒）", () => {
    expect(dateIn("Asia/Shanghai", new Date("2026-10-14T15:59:59Z"))).toBe("2026-10-14");
    expect(dateIn("Asia/Shanghai", new Date("2026-10-14T16:00:00Z"))).toBe("2026-10-15");
  });

  it("todayIn 不传时刻时用当下", () => {
    expect(todayIn("UTC")).toBe(dateIn("UTC", new Date()));
  });

  it("美西的日界：当地午夜前后各取一秒，跨夏令时当日（2026-03-08）", () => {
    // 03-08 当地仍是 PST(UTC-8)，其午夜 = 08:00Z
    expect(dateIn("America/Los_Angeles", new Date("2026-03-08T07:59:59Z"))).toBe("2026-03-07");
    expect(dateIn("America/Los_Angeles", new Date("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
  });

  it("月份与日恒为两位（sv-SE 那套凑巧可用的写法不再依赖 locale）", () => {
    expect(dateIn("UTC", new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
  });
});

describe("formatDateTime / formatShortDateTime / formatDateShort", () => {
  it("按目标时区给钟面读数", () => {
    const at = new Date("2026-10-14T12:34:00Z");
    expect(formatDateTime("Asia/Shanghai", at)).toBe("2026-10-14 20:34");
    expect(formatDateTime("UTC", at)).toBe("2026-10-14 12:34");
    expect(formatDateTime("America/New_York", at)).toBe("2026-10-14 08:34");
  });

  it("午夜给出 00:xx 而不是 24:xx", () => {
    expect(formatDateTime("Asia/Shanghai", new Date("2026-10-14T16:00:00Z"))).toBe("2026-10-15 00:00");
  });

  it("短格式：月不去零、日去零", () => {
    const at = new Date("2026-01-05T12:34:00Z");
    expect(formatShortDateTime("UTC", at)).toBe("1/05 12:34");
    expect(formatDateShort("UTC", at)).toBe("1/05");
  });

  it("夏令时切换：同一个 03-08 上午，偏移从 PST 跳到 PDT", () => {
    // 2:00 当地（10:00Z）跳过一小时
    expect(formatDateTime("America/Los_Angeles", new Date("2026-03-08T09:59:00Z"))).toBe(
      "2026-03-08 01:59",
    );
    expect(formatDateTime("America/Los_Angeles", new Date("2026-03-08T10:00:00Z"))).toBe(
      "2026-03-08 03:00",
    );
  });

  it("夏令时结束：当地 01:30 出现两次，偏移从 PDT 落到 PST", () => {
    expect(formatDateTime("America/Los_Angeles", new Date("2026-11-01T08:30:00Z"))).toBe(
      "2026-11-01 01:30",
    );
    expect(formatDateTime("America/Los_Angeles", new Date("2026-11-01T09:30:00Z"))).toBe(
      "2026-11-01 01:30",
    );
    // 但两者是两个不同的时刻
    expect(new Date("2026-11-01T08:30:00Z").getTime()).not.toBe(
      new Date("2026-11-01T09:30:00Z").getTime(),
    );
  });
});

describe("clockParts", () => {
  it("拆出钟面读数、中文日期与星期几（0=周日）", () => {
    const p = clockParts("Asia/Shanghai", new Date("2026-10-14T12:34:56Z"));
    expect(p).toMatchObject({
      hh: "20",
      mm: "34",
      ss: "56",
      hour: 20,
      weekday: 3, // 2026-10-14 是周三
      dateLabel: "2026年10月14日",
    });
  });

  it("星期几跟着目标时区走，不跟宿主", () => {
    // 这一刻上海已是 10-15（周四），UTC 还是 10-14（周三）
    const at = new Date("2026-10-14T17:00:00Z");
    expect(clockParts("Asia/Shanghai", at).weekday).toBe(4);
    expect(clockParts("UTC", at).weekday).toBe(3);
  });
});

describe("addDays（日历日，绝不经过时区）", () => {
  it("跨月、跨年", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("闰日", () => {
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2024-02-29", 1)).toBe("2024-03-01");
    expect(addDays("2025-02-28", 1)).toBe("2025-03-01");
  });

  it("加 0 天原样返回；负数是往前", () => {
    expect(addDays("2026-10-14", 0)).toBe("2026-10-14");
    expect(addDays("2026-10-14", -14)).toBe("2026-09-30");
  });

  it("不接受非 YYYY-MM-DD（宁可炸，也别默默算错一天）", () => {
    expect(() => addDays("2026/10/14", 1)).toThrow();
    expect(() => addDays("2026-10-14T00:00:00Z", 1)).toThrow();
  });
});

describe("zonedWallClockToInstant（输入框的墙面时间 → 时刻）", () => {
  it("往返一致：写进去什么读数，读出来还是什么读数", () => {
    const zones = [
      "Asia/Shanghai",
      "UTC",
      "America/New_York",
      "America/Los_Angeles",
      "Europe/Paris",
      "Pacific/Kiritimati",
      "Pacific/Midway",
    ];
    const wallClocks = [
      "2026-10-14T20:30",
      "2026-01-01T00:00",
      "2026-12-31T23:59",
      "2026-03-08T03:30", // 美西夏令时切换当天，但落在切换之后
      "2026-11-01T05:00", // 美西夏令时结束当天，但落在两段之外
    ];
    for (const tz of zones) {
      for (const w of wallClocks) {
        expect(formatInputValue(tz, zonedWallClockToInstant(tz, w))).toBe(w);
      }
    }
  });

  it("上海 20:30 就是 12:30Z —— 不是按宿主进程的时区去解析", () => {
    expect(zonedWallClockToInstant("Asia/Shanghai", "2026-10-14T20:30").toISOString()).toBe(
      "2026-10-14T12:30:00.000Z",
    );
    expect(zonedWallClockToInstant("UTC", "2026-10-14T20:30").toISOString()).toBe(
      "2026-10-14T20:30:00.000Z",
    );
  });

  it("秒与空格分隔也认", () => {
    expect(zonedWallClockToInstant("UTC", "2026-10-14 08:05").toISOString()).toBe(
      "2026-10-14T08:05:00.000Z",
    );
    expect(zonedWallClockToInstant("UTC", "2026-10-14T08:05:30").toISOString()).toBe(
      "2026-10-14T08:05:30.000Z",
    );
  });

  it("解析不了就炸（别拿 Invalid Date 去写库）", () => {
    expect(() => zonedWallClockToInstant("UTC", "2026-10-14")).toThrow();
    expect(() => zonedWallClockToInstant("UTC", "")).toThrow();
  });

  // 已知边界：夏令时「跳过」的那一小时（如美西 2026-03-08 的 02:30）在当地并不存在，
  // 本函数会把它挪到相邻的某个真实时刻，故往返测试刻意避开了那一小时。
});

describe("isValidTimeZone / resolveTimeZone", () => {
  it("认得 IANA 名与 UTC，不认别的", () => {
    expect(isValidTimeZone("Asia/Shanghai")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(isValidTimeZone("auto")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
  });

  it("默认就是中国时间：任何取不到的值都退回它", () => {
    expect(DEFAULT_TIMEZONE).toBe("Asia/Shanghai");
    expect(resolveTimeZone(null)).toBe("Asia/Shanghai");
    expect(resolveTimeZone(undefined)).toBe("Asia/Shanghai");
    expect(resolveTimeZone("")).toBe("Asia/Shanghai");
    expect(resolveTimeZone("Bogus/Zone")).toBe("Asia/Shanghai");
  });

  it("跟随浏览器：有浏览器时区就用它，没有就仍是中国时间", () => {
    expect(resolveTimeZone("auto", "Europe/Paris")).toBe("Europe/Paris");
    expect(resolveTimeZone("auto", null)).toBe("Asia/Shanghai");
    expect(resolveTimeZone("auto", "Bogus/Zone")).toBe("Asia/Shanghai");
  });

  it("显式时区原样返回", () => {
    expect(resolveTimeZone("UTC")).toBe("UTC");
    expect(resolveTimeZone("America/New_York")).toBe("America/New_York");
  });
});

describe("与 schema 的约定", () => {
  it("users.timezone 的库默认值就是 DEFAULT_TIMEZONE（两处字面量不许漂）", () => {
    // schema.ts 不能引应用侧的常量（drizzle-kit 独立加载它），所以那边写的是字面量。
    // 这条用例是那两份值之间的唯一一道围栏。
    expect(users.timezone.default).toBe(DEFAULT_TIMEZONE);
    expect(users.timezone.notNull).toBe(true);
  });
});

describe("offsetLabel / listTimeZones", () => {
  it("偏移提示带得上小时数", () => {
    expect(offsetLabel("Asia/Shanghai", new Date("2026-10-14T00:00:00Z"))).toContain("8");
    expect(offsetLabel("UTC", new Date("2026-10-14T00:00:00Z"))).toContain("0");
  });

  it("选项表：中国时间第一，置顶三项各出现一次，其余是 IANA 名", () => {
    const opts = listTimeZones();
    expect(opts[0]).toMatchObject({ value: "Asia/Shanghai" });
    expect(opts.map((o) => o.value)).toContain("auto");
    expect(opts.map((o) => o.value)).toContain("UTC");
    expect(opts.map((o) => o.value)).toContain("Europe/Paris");
    // 置顶项不与 ICU 全量表重复
    expect(opts.filter((o) => o.value === "UTC")).toHaveLength(1);
    expect(opts.filter((o) => o.value === "Asia/Shanghai")).toHaveLength(1);
    expect(opts.every((o) => o.label.length > 0)).toBe(true);
  });
});
