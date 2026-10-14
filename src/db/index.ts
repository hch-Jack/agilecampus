import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as { dbClient?: ReturnType<typeof postgres> };

const client = globalForDb.dbClient ?? postgres(process.env.DATABASE_URL!);
if (process.env.NODE_ENV !== "production") globalForDb.dbClient = client;

/**
 * 探明本库的会话时区，交给 schema.ts 的时间列用来换算。
 *
 * 必须在这里、且只探一次：无时区 `timestamp` 列存的是**某个时区的钟面读数**，
 * 而要按哪个时区还原，光看数据是看不出来的（同一个 `18:19` 既可能是北京也可能是 UTC），
 * 只能问库自己。列映射是同步函数，没法在里面查库，故在模块初始化时取好。
 * 见 schema.ts 的 `dbTimestamp`。
 */
try {
  const [row] = await client<{ tz: string }[]>`select current_setting('TimeZone') as tz`;
  schema.setDbTimeZone(row?.tz);
} catch {
  // 探不到就保留 UTC 兜底：此时任何查询本来都会失败，不必在这儿再抛一次
}

export const db = drizzle(client, { schema });

// 事务连接类型：createTask/updateTask 等可选在事务内执行
export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
