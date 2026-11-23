import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { libraryOperations, users } from "@/db/schema";
import type { DbExec } from "@/lib/documents/types";
import type { LibraryOperationView } from "./types";

export async function recordLibraryOperation(
  exec: DbExec,
  input: {
    libraryId: string;
    itemId?: string | null;
    folderId?: string | null;
    actorId: string | null;
    actorName?: string;
    type: string;
    oldValue?: string | null;
    newValue?: string | null;
    note?: string | null;
  },
): Promise<void> {
  let actorName = input.actorName;
  if (!actorName && input.actorId) {
    const [row] = await exec
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, input.actorId));
    actorName = row?.name ?? undefined;
  }
  await exec.insert(libraryOperations).values({
    libraryId: input.libraryId,
    itemId: input.itemId ?? null,
    folderId: input.folderId ?? null,
    actorId: input.actorId,
    actorName: actorName ?? "系统",
    type: input.type,
    oldValue: input.oldValue ?? null,
    newValue: input.newValue ?? null,
    note: input.note ?? null,
  });
}

export async function listLibraryOperations(
  libraryId: string,
  opts: { itemId?: string; limit?: number } = {},
): Promise<LibraryOperationView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: libraryOperations.id,
      itemId: libraryOperations.itemId,
      type: libraryOperations.type,
      oldValue: libraryOperations.oldValue,
      newValue: libraryOperations.newValue,
      note: libraryOperations.note,
      actorName: libraryOperations.actorName,
      createdAt: libraryOperations.createdAt,
    })
    .from(libraryOperations)
    .where(
      opts.itemId
        ? and(
            eq(libraryOperations.libraryId, libraryId),
            eq(libraryOperations.itemId, opts.itemId),
          )
        : eq(libraryOperations.libraryId, libraryId),
    )
    .orderBy(desc(libraryOperations.createdAt))
    .limit(limit);
  return rows;
}
