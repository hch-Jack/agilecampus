import { db } from "@/db";
import {
  agentFiles,
  dmAttachments,
  dmGroupMembers,
  dmGroupMessages,
  dmGroups,
  dmMessages,
} from "@/db/schema";
import { saveAgentFile } from "@/lib/agent/files";
import { createUser } from "@/lib/user";

export async function makeUser(label: string) {
  return createUser({
    email: `${label}@example.com`,
    password: "password123",
    name: label,
  });
}

export async function addDmFile(
  senderId: string,
  recipientId: string,
  filename: string,
  content: string,
) {
  const data = Buffer.from(content, "utf8");
  const [att] = await db
    .insert(dmAttachments)
    .values({
      uploaderId: senderId,
      filename,
      mimeType: "text/plain",
      size: data.length,
      data,
    })
    .returning();
  const [msg] = await db
    .insert(dmMessages)
    .values({ senderId, recipientId, attachmentId: att.id })
    .returning();
  return { attachment: att, message: msg };
}

export async function addAgentFile(ownerId: string, filename: string, content: string) {
  return saveAgentFile(ownerId, {
    filename,
    mimeType: "text/plain",
    data: Buffer.from(content, "utf8"),
  });
}

export async function makeGroupWithFiles(
  ownerId: string,
  memberIds: string[],
  files: { senderId: string; filename: string; content: string }[],
) {
  const [group] = await db.insert(dmGroups).values({ name: "资料群", ownerId }).returning();
  for (const userId of [ownerId, ...memberIds]) {
    await db.insert(dmGroupMembers).values({ groupId: group.id, userId });
  }
  const attachments: { attachmentId: string; messageId: string }[] = [];
  for (const f of files) {
    const data = Buffer.from(f.content, "utf8");
    const [att] = await db
      .insert(dmAttachments)
      .values({
        uploaderId: f.senderId,
        filename: f.filename,
        mimeType: "text/plain",
        size: data.length,
        data,
      })
      .returning();
    const [msg] = await db
      .insert(dmGroupMessages)
      .values({ groupId: group.id, senderId: f.senderId, attachmentId: att.id })
      .returning();
    attachments.push({ attachmentId: att.id, messageId: msg.id });
  }
  return { group, attachments };
}

export async function addGroupFile(
  groupId: string,
  senderId: string,
  filename: string,
  content: string,
) {
  const data = Buffer.from(content, "utf8");
  const [att] = await db
    .insert(dmAttachments)
    .values({
      uploaderId: senderId,
      filename,
      mimeType: "text/plain",
      size: data.length,
      data,
    })
    .returning();
  const [msg] = await db
    .insert(dmGroupMessages)
    .values({ groupId, senderId, attachmentId: att.id })
    .returning();
  return { attachment: att, message: msg };
}

export async function addLegacyTaskAttachment(taskId: string, uploaderId: string, filename: string, content: string) {
  const { taskAttachments } = await import("@/db/schema");
  const data = Buffer.from(content, "utf8");
  const [row] = await db
    .insert(taskAttachments)
    .values({
      taskId,
      uploaderId,
      filename,
      mimeType: "text/plain",
      size: data.length,
      data,
      storageKey: null,
    })
    .returning();
  return row;
}

export async function addAgentFileRow(ownerId: string, filename: string, content: string) {
  const data = Buffer.from(content, "utf8");
  const [row] = await db
    .insert(agentFiles)
    .values({
      ownerId,
      filename,
      mimeType: "text/plain",
      size: data.length,
      data,
    })
    .returning();
  return row;
}
