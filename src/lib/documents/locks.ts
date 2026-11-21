import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { documentLocks, documents, users } from "@/db/schema";
import { AppError, DocumentLockError } from "@/lib/errors";
import type { DbExec, LockView } from "./types";

/** 锁 TTL 90s；客户端 30s 心跳。过期锁在下一次获取时被直接覆盖。 */
export const LOCK_TTL_SECONDS = 90;

export async function getLockView(
  documentId: string,
  exec: DbExec = db,
): Promise<LockView | null> {
  const [row] = await exec
    .select({
      userId: documentLocks.userId,
      sessionId: documentLocks.sessionId,
      acquiredAt: documentLocks.acquiredAt,
      expiresAt: documentLocks.expiresAt,
      userName: users.name,
    })
    .from(documentLocks)
    .leftJoin(users, eq(documentLocks.userId, users.id))
    .where(eq(documentLocks.documentId, documentId));
  if (!row) return null;
  return {
    userId: row.userId,
    userName: row.userName,
    sessionId: row.sessionId,
    acquiredAt: row.acquiredAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * 获取单人编辑锁。文档行 `FOR UPDATE` 串行化「获取锁」与「切换协作开关」，
 * 避免开关刚打开时又有人拿到锁。返回 null 表示锁被他人持有且未过期。
 */
export async function acquireLock(
  documentId: string,
  userId: string,
  sessionId: string,
): Promise<LockView | null> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .select({ collaborationEnabled: documents.collaborationEnabled })
      .from(documents)
      .where(eq(documents.id, documentId))
      .for("update");
    if (!doc) throw new AppError("文档不存在");
    if (doc.collaborationEnabled) {
      throw new DocumentLockError("该文档已开启多人协作，无需获取编辑锁", "collaboration_enabled");
    }

    const rows = (await tx.execute(sql`
      insert into document_locks (document_id, user_id, session_id, acquired_at, expires_at)
      values (${documentId}, ${userId}, ${sessionId}, now(), now() + interval '${sql.raw(String(LOCK_TTL_SECONDS))} seconds')
      on conflict (document_id) do update
        set user_id = excluded.user_id,
            session_id = excluded.session_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at
        where document_locks.expires_at <= now()
           or document_locks.user_id = excluded.user_id
      returning document_id
    `)) as unknown as { document_id: string }[];
    if (rows.length === 0) return null;
    return getLockView(documentId, tx);
  });
}

/** 续约。返回 false = 锁已过期或被他人接管 */
export async function touchLock(
  documentId: string,
  userId: string,
  sessionId: string,
): Promise<LockView | null> {
  const rows = await db
    .update(documentLocks)
    .set({ expiresAt: sql`now() + interval '${sql.raw(String(LOCK_TTL_SECONDS))} seconds'` })
    .where(
      and(
        eq(documentLocks.documentId, documentId),
        eq(documentLocks.userId, userId),
        eq(documentLocks.sessionId, sessionId),
        sql`${documentLocks.expiresAt} > now()`,
      ),
    )
    .returning({ documentId: documentLocks.documentId });
  if (rows.length === 0) return null;
  return getLockView(documentId);
}

export async function releaseLock(
  documentId: string,
  userId: string,
  sessionId: string,
): Promise<void> {
  await db
    .delete(documentLocks)
    .where(
      and(
        eq(documentLocks.documentId, documentId),
        eq(documentLocks.userId, userId),
        eq(documentLocks.sessionId, sessionId),
      ),
    );
}

/** 保存事务内断言：当前用户仍持锁且未过期 */
export async function assertLockHeld(
  exec: DbExec,
  documentId: string,
  userId: string,
  sessionId: string,
): Promise<void> {
  const [row] = await exec
    .select({
      userId: documentLocks.userId,
      sessionId: documentLocks.sessionId,
    })
    .from(documentLocks)
    .where(
      and(
        eq(documentLocks.documentId, documentId),
        sql`${documentLocks.expiresAt} > now()`,
      ),
    );
  if (!row || row.userId !== userId || row.sessionId !== sessionId) {
    throw new DocumentLockError("编辑锁已失效，请重新获取", "lost");
  }
}

export async function deleteLocksForDocument(exec: DbExec, documentId: string): Promise<void> {
  await exec.delete(documentLocks).where(eq(documentLocks.documentId, documentId));
}

export async function deleteLockForUser(
  exec: DbExec,
  documentId: string,
  userId: string,
): Promise<void> {
  await exec
    .delete(documentLocks)
    .where(and(eq(documentLocks.documentId, documentId), eq(documentLocks.userId, userId)));
}
