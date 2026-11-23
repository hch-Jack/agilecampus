"use client";

import { useEffect, useRef } from "react";
import type { DocumentEvent } from "@/lib/documents/types";

type Handlers = {
  [K in DocumentEvent["type"]]?: (event: Extract<DocumentEvent, { type: K }>) => void;
};

/**
 * 订阅文档 SSE。EventSource 自带断线重连；handler 放 ref 里，
 * 父组件状态变化不会导致反复重连。
 */
export function useDocumentEvents(documentId: string, handlers: Handlers): void {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const source = new EventSource(`/api/documents/${documentId}/events`);
    const types: DocumentEvent["type"][] = [
      "hello",
      "presence",
      "saved",
      "settings",
      "permission",
      "lock",
      "revoked",
    ];
    const listeners = types.map((type) => {
      const listener = (e: MessageEvent) => {
        try {
          const event = JSON.parse(e.data) as DocumentEvent;
          if (event.type !== type) return;
          const handler = handlersRef.current[type] as
            | ((event: DocumentEvent) => void)
            | undefined;
          handler?.(event);
        } catch {
          // 忽略坏帧
        }
      };
      source.addEventListener(type, listener as EventListener);
      return { type, listener };
    });

    return () => {
      for (const { type, listener } of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
    };
  }, [documentId]);
}
