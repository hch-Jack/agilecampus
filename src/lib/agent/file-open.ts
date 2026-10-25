import { getChatAttachmentInfo, type ChatAttachmentSource } from "@/lib/chat-transfer";

/**
 * 助手「打开附件预览」。
 *
 * 与「打开页面」同口径：模型只报附件来源 + id，URL 与文件名/类型由服务端从库里查，
 * 权限复用附件下载的同一套校验（任务附件按项目成员、消息附件按私信/群成员）。
 * 客户端拿到信封后直接挂预览弹窗 —— 下载路由带会话 cookie，不额外开权限口子。
 */

export type FileOpenEnvelope = {
  __showFile: true;
  url: string;
  filename: string;
  mimeType: string | null;
  size: number;
};

export async function resolveFileOpen(
  actorId: string,
  input: ChatAttachmentSource,
): Promise<FileOpenEnvelope> {
  const info = await getChatAttachmentInfo(actorId, input);
  const base = input.source === "task" ? "/api/attachments" : "/api/dm/attachments";
  return {
    __showFile: true as const,
    url: `${base}/${info.attachmentId}`,
    filename: info.filename,
    mimeType: info.mimeType,
    size: info.size,
  };
}

export function isFileOpenEnvelope(value: unknown): value is FileOpenEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __showFile?: unknown }).__showFile === true
  );
}
