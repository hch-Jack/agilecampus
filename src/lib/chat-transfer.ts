import { AppError } from "./errors";
import {
  getDmAttachmentForDownload,
  getDmAttachmentMeta,
  getDmMessageForForward,
  getDmPeer,
  sendDm,
} from "./dm";
import {
  getGroupInfo,
  getGroupMessageForForward,
  sendGroupMessage,
} from "./group-chat";
import {
  getAttachmentForDownload,
  getAttachmentMeta,
} from "./attachment";

/**
 * 消息发送 / 转发的公共实现。
 *
 * 助手草案落库与 REST 接口共用这一层，避免两处各写一遍「取附件字节 → 发私信/群消息」
 * 的权限校验。所有函数都只信调用方给的 actorId（session 或 Bearer token），
 * 目标存在性、群成员身份、附件可读性均在这里或其下调用的 lib 中重校。
 */

export type ChatTarget =
  | { kind: "user"; id: string }
  | { kind: "group"; id: string };

export type ChatAttachmentSource = {
  /** task = 任务附件（项目文件）；message = 私信/群聊附件（转发文件） */
  source: "task" | "message";
  attachmentId: string;
};

export type ChatAttachmentInfo = ChatAttachmentSource & {
  filename: string;
  mimeType: string | null;
  size: number;
};

export type ForwardSourceType = "dm" | "group";

export type ForwardableSource = {
  content: string;
  senderName: string;
  /** 卡片上展示的来源，如「与张三的私信」「群聊「讨论组」」 */
  sourceLabel: string;
  attachment: {
    id: string;
    filename: string;
    mimeType: string | null;
    size: number;
  } | null;
};

/** 只取附件元数据（不含 blob），供拟稿与卡片展示。 */
export async function getChatAttachmentInfo(
  actorId: string,
  source: ChatAttachmentSource,
): Promise<ChatAttachmentInfo> {
  if (source.source === "task") {
    const row = await getAttachmentMeta(actorId, source.attachmentId);
    return {
      source: "task",
      attachmentId: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
    };
  }
  const row = await getDmAttachmentMeta(actorId, source.attachmentId);
  return {
    source: "message",
    attachmentId: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
  };
}

/** 取附件内容（含 blob）。权限口径与下载一致。 */
export async function loadChatAttachment(
  actorId: string,
  source: ChatAttachmentSource,
): Promise<ChatAttachmentInfo & { data: Buffer }> {
  if (source.source === "task") {
    const row = await getAttachmentForDownload(actorId, source.attachmentId);
    return {
      source: "task",
      attachmentId: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      size: row.size,
      data: Buffer.from(row.data),
    };
  }
  const row = await getDmAttachmentForDownload(actorId, source.attachmentId);
  return {
    source: "message",
    attachmentId: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    data: Buffer.from(row.data),
  };
}

/** 校验发送目标并取展示名：私信对端须存在且不是自己；群聊须仍在群里。 */
export async function resolveChatTarget(
  actorId: string,
  target: ChatTarget,
): Promise<{ name: string }> {
  if (target.kind === "user") {
    const peer = await getDmPeer(actorId, target.id);
    return { name: peer.name };
  }
  const group = await getGroupInfo(actorId, target.id);
  return { name: group.name };
}

/**
 * 发送一条消息（文本与附件至少其一）。
 * 附件按 `source` 从任务附件或消息附件读字节后**复制**进 dm_attachments ——
 * 跨表没有共享行，这也是「把项目文件发给别人」与「转发文件」的统一实现。
 */
export async function sendChatMessage(
  actorId: string,
  target: ChatTarget,
  input: { content?: string; attachment?: ChatAttachmentSource | null },
): Promise<{ targetName: string }> {
  const content = (input.content ?? "").trim();
  const attachmentSource = input.attachment ?? null;
  if (!content && !attachmentSource) throw new AppError("不能发送空消息");

  // 先校验目标（含群成员身份），再读附件字节：目标不合法时不必把 10MB blob 拉出来
  const targetInfo = await resolveChatTarget(actorId, target);
  const att = attachmentSource ? await loadChatAttachment(actorId, attachmentSource) : null;
  const file = att
    ? {
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        data: att.data,
      }
    : null;

  if (target.kind === "user") await sendDm(actorId, target.id, { content, file });
  else await sendGroupMessage(actorId, target.id, { content, file });

  return { targetName: targetInfo.name };
}

/** 读转发源：私信收发双方、群成员；并核验 sourceId 与消息实际所属会话一致。 */
export async function getForwardSource(
  actorId: string,
  sourceType: ForwardSourceType,
  sourceId: string,
  messageId: string,
): Promise<ForwardableSource> {
  if (sourceType === "dm") {
    const message = await getDmMessageForForward(actorId, messageId);
    if (message.peerId !== sourceId) throw new AppError("消息不属于该私信会话");
    return {
      content: message.content,
      senderName: message.senderName,
      sourceLabel: `与 ${message.peerName} 的私信`,
      attachment: message.attachment,
    };
  }

  const message = await getGroupMessageForForward(actorId, sourceId, messageId);
  return {
    content: message.content,
    senderName: message.senderName,
    sourceLabel: `群聊「${message.groupName}」`,
    attachment: message.attachment,
  };
}

/**
 * 把一条已有消息原样转发到个人或群聊。
 * 正文保持原样；有附件就复制附件字节。转发本身也会被目标侧当作一条新消息。
 */
export async function forwardChatMessage(
  actorId: string,
  source: { sourceType: ForwardSourceType; sourceId: string; messageId: string },
  target: ChatTarget,
): Promise<{ targetName: string; sourceLabel: string }> {
  const src = await getForwardSource(
    actorId,
    source.sourceType,
    source.sourceId,
    source.messageId,
  );
  if (!src.content.trim() && !src.attachment) throw new AppError("这条消息没有可转发的内容");

  const { targetName } = await sendChatMessage(actorId, target, {
    content: src.content,
    attachment: src.attachment
      ? { source: "message", attachmentId: src.attachment.id }
      : null,
  });
  return { targetName, sourceLabel: src.sourceLabel };
}
