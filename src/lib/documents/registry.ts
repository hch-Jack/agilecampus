import { AppError } from "@/lib/errors";
import { taskAttachmentAdapter } from "./adapters/task-attachment";
import type { DocumentSourceAdapter } from "./types";

/**
 * 文档来源注册表。显式注册（不依赖 import 副作用顺序），
 * 未来「总资源库」只需在这里追加一个 adapter。
 */
const adapters = new Map<string, DocumentSourceAdapter>();

export function registerDocumentSourceAdapter(adapter: DocumentSourceAdapter): void {
  adapters.set(adapter.sourceType, adapter);
}

export function getDocumentSourceAdapter(type: string): DocumentSourceAdapter {
  const adapter = adapters.get(type);
  if (!adapter) throw new AppError("不支持的文档来源");
  return adapter;
}

export function hasDocumentSourceAdapter(type: string): boolean {
  return adapters.has(type);
}

registerDocumentSourceAdapter(taskAttachmentAdapter);
