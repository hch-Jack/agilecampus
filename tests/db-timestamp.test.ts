import { describe, it, expect, beforeEach } from "vitest";
import { getTableColumns, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import * as schema from "@/db/schema";
import { getDbTimeZone, setDbTimeZone } from "@/db/schema";
import { dbWallClockToInstant, instantToDbWallClock } from "@/lib/time";
import { resetDb } from "./helpers";

// 站内所有时间列都是**无时区** `timestamp`，存的是钟面读数，而钟面属于哪个时区
// 光看数据看不出来。这一文件守的是「读写只有一套口径」：
//   · 库自己写的（`now()` / `defaultNow()`）落的是**会话时区**的钟面；
//   · 应用写的也必须落同一个口径，读回来也按同一个时区还原。
// 两边不一致时的症状就是整站时间差一个偏移 —— 库会话在 +08 的那些部署里，
// 每个「创建于/更新于/活动日志」都慢 8 小时（详见 docs/BACKLOG.md）。

// name 从 email 派生：`users_name_unique` 是私信按用户名定位引入的全站唯一约束，
// 这几条用例要建多个用户，名字撞了会先炸在唯一键上，跟被测的时间口径无关
async function makeUser(email: string, feishuBoundAt?: Date) {
  const [row] = await db
    .insert(schema.users)
    .values({ email, passwordHash: "x", name: email.split("@")[0], feishuBoundAt })
    .returning();
  return row;
}

/** 取库里那一列的原始文本（绕过 drizzle 的列映射，看落盘到底写了什么） */
async function rawColumn(id: string, column: "created_at" | "feishu_bound_at") {
  const rows = (await db.execute(
    column === "created_at"
      ? sql`select created_at::text as w from users where id = ${id}`
      : sql`select feishu_bound_at::text as w from users where id = ${id}`,
  )) as unknown as { w: string }[];
  return String(rows[0].w);
}

describe("无时区 timestamp 列的读写口径", () => {
  beforeEach(resetDb);

  it("连上库时探明了会话时区，且与库自报的一致", async () => {
    const rows = (await db.execute(
      sql`select current_setting('TimeZone') as tz`,
    )) as unknown as { tz: string }[];
    expect(getDbTimeZone()).toBe(rows[0].tz);
  });

  it("库时钟写入的时间读回来就是当下 —— 本役 bug 的回归用例", async () => {
    const before = Date.now();
    const user = await makeUser("clock@example.com");
    const after = Date.now();

    // 库里落的是 now()。口径错时这里会整整差一个偏移（+08 的库上就是慢 8 小时），
    // 而旧实现恰好把 18:19 的钟面读成 18:19Z，落在未来。
    expect(user.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(user.createdAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("库自己写的与应用写的是同一套口径（同一时区读回来即同一时刻）", async () => {
    const stamped = new Date("2026-10-14T12:34:56.789Z");
    const viaDb = await makeUser("db@example.com");
    const viaApp = await makeUser("app@example.com", stamped);
    const tz = getDbTimeZone();

    // createdAt 由 defaultNow() 写；feishuBoundAt 由应用显式传入。
    // 两列用同一个时区还原，都必须得到各自那个真实时刻。
    expect(dbWallClockToInstant(tz, await rawColumn(viaDb.id, "created_at")).getTime()).toBe(
      viaDb.createdAt.getTime(),
    );
    expect(dbWallClockToInstant(tz, await rawColumn(viaApp.id, "feishu_bound_at")).getTime()).toBe(
      stamped.getTime(),
    );
  });

  it("显式传入的时刻往返一致，落盘的是会话时区的钟面（不是 UTC 钟面）", async () => {
    const stamped = new Date("2026-10-14T12:34:56.789Z");
    const user = await makeUser("roundtrip@example.com", stamped);
    expect(user.feishuBoundAt?.getTime()).toBe(stamped.getTime());

    const raw = await rawColumn(user.id, "feishu_bound_at");
    const expected = instantToDbWallClock(getDbTimeZone(), stamped);
    // 逐秒比（PG 存到微秒、写到毫秒），比到毫秒用上面那条往返来守
    expect(raw.slice(0, 19)).toBe(expected.slice(0, 19));
  });

  it("会话时区是 +08 时映射按 +08 换算 —— bug 的最小复现（与 CI 的 UTC 库无关）", () => {
    const column = getTableColumns(schema.tasks).createdAt as unknown as {
      mapFromDriverValue(v: string): Date;
      mapToDriverValue(v: Date): string;
    };
    const real = getDbTimeZone();
    try {
      setDbTimeZone("Asia/Shanghai");
      // drizzle 自带的 timestamp() 在这里会给出 2026-10-14T18:19:13.850Z（当 UTC），
      // 于是页面上按北京时间显示成 2026-10-15 02:19 —— 正是线上看到的现象
      expect(column.mapFromDriverValue("2026-10-14 18:19:13.850195").toISOString()).toBe(
        "2026-10-14T10:19:13.850Z",
      );
      expect(column.mapToDriverValue(new Date("2026-10-14T10:19:13.850Z"))).toBe(
        "2026-10-14 18:19:13.850",
      );
    } finally {
      setDbTimeZone(real);
    }
  });

  it("会话时区非法或探不到时，保留原值不炸", () => {
    const real = getDbTimeZone();
    setDbTimeZone("不是时区");
    setDbTimeZone(undefined);
    setDbTimeZone(42);
    expect(getDbTimeZone()).toBe(real);
  });
});

describe("时间列的物理 schema 没有变（db:push 不该产生 ALTER）", () => {
  it("每一条时间列仍是 timestamp，且默认值的有无与改动前逐一相同", () => {
    const columns: { sqlType: string; hasDefault: boolean }[] = [];
    for (const table of Object.values(schema)) {
      if (!is(table, PgTable)) continue;
      for (const column of Object.values(getTableColumns(table))) {
        if (column.getSQLType() !== "timestamp") continue;
        columns.push({ sqlType: column.getSQLType(), hasDefault: column.hasDefault });
      }
    }

    // 数目是对不上就说明有人绕开了 dbTimestamp 自己搓了一个时间列
    // （私信/动态流/群聊那几张表后来加过一轮，个人上下文表又加了一轮，留言板再加一轮，
    // 新手教程打点又加一轮，助手多会话又加了 conversations.last_message_at，
    // 动态单条隐藏又加了 activity_hides.created_at，
    // 审批表又加了 approval_requests 的四个（资源快照起止 + 决定时刻 + 行创建），
    // 工作台日程表又加了 task_plans 的 created_at/updated_at，
    // 系统消息又加了 system_messages 的 created_at/read_at ——
    // 加表/加时间列就得同步这个数）
    expect(columns).toHaveLength(46);
    for (const c of columns) expect(c.sqlType).toBe("timestamp");

    // createdAt / updatedAt 由 dbTimestampNow 声明，默认值必须在；
    // feishuBoundAt 等本来没有默认值，绝不能被加上（那会驱动 db:push 去 ALTER）
    expect(getTableColumns(schema.users).createdAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.tasks).updatedAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.users).feishuBoundAt.hasDefault).toBe(false);
    expect(getTableColumns(schema.users).avatarUpdatedAt.hasDefault).toBe(false);
    expect(getTableColumns(schema.resourceUsages).endTime.hasDefault).toBe(false);
    expect(getTableColumns(schema.resourceUsages).startTime.hasDefault).toBe(false);
    // 私信：消息时刻由库写、已读时刻由应用写（可为空，不能有默认值）；
    // 动态流已读水位线由库写（要有默认值，否则新用户没有起点）
    expect(getTableColumns(schema.dmMessages).createdAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.dmMessages).readAt.hasDefault).toBe(false);
    expect(getTableColumns(schema.feedReads).lastReadAt.hasDefault).toBe(true);
    // 动态流「清除记录」时刻由应用写（可空，不能有默认值）
    expect(getTableColumns(schema.feedReads).clearedAt.hasDefault).toBe(false);
    // 动态单条隐藏：隐藏时刻随行由库写，默认值必须在
    expect(getTableColumns(schema.activityHides).createdAt.hasDefault).toBe(true);
    // 新手教程打点由应用在首次弹出时写（可空，不能有默认值）
    expect(getTableColumns(schema.users).tutorialSeenAt.hasDefault).toBe(false);
    // 个人上下文：两条都随行由库写，都要有默认值
    expect(getTableColumns(schema.personalContexts).createdAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.personalContexts).updatedAt.hasDefault).toBe(true);
    // 群聊：成员表的未读基线/入群时刻都由库写（有默认值，入群即起算）
    expect(getTableColumns(schema.dmGroupMembers).lastReadAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.dmGroupMembers).joinedAt.hasDefault).toBe(true);
    // 审批：资源快照起止与决定时刻由应用写（可空，不能有默认值），行创建由库写
    expect(getTableColumns(schema.approvalRequests).startTime.hasDefault).toBe(false);
    expect(getTableColumns(schema.approvalRequests).endTime.hasDefault).toBe(false);
    expect(getTableColumns(schema.approvalRequests).decidedAt.hasDefault).toBe(false);
    expect(getTableColumns(schema.approvalRequests).createdAt.hasDefault).toBe(true);
    // 工作台日程表：个人计划段的创建/更新时刻随行由库写，默认值必须在
    expect(getTableColumns(schema.taskPlans).createdAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.taskPlans).updatedAt.hasDefault).toBe(true);
    // 系统消息：行创建由库写（有默认值）；已读时刻由应用写（可空，不能有默认值）
    expect(getTableColumns(schema.systemMessages).createdAt.hasDefault).toBe(true);
    expect(getTableColumns(schema.systemMessages).readAt.hasDefault).toBe(false);
  });
});
