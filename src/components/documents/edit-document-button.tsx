"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  sourceType: string;
  sourceId: string;
  className?: string;
  label?: string;
};

/**
 * 「在线编辑」入口：按来源懒创建文档后跳到独立的编辑页。
 * 不可编辑的格式由服务端返回 403/400，这里统一提示。
 */
export function EditDocumentButton({
  sourceType,
  sourceId,
  className = "ac-btn shrink-0 px-2.5 py-1 text-xs",
  label = "在线编辑",
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function open() {
    setBusy(true);
    try {
      // 部署/重启的一两秒内请求会直接失败：自动重试一次，避免三种格式都报「无法加载」
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch("/api/documents/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sourceType, sourceId }),
          });
          const data = (await res.json().catch(() => null)) as
            | { documentId?: string; error?: string }
            | null;
          if (!res.ok || !data?.documentId) {
            window.alert(data?.error ?? "无法打开在线编辑器");
            return;
          }
          router.push(`/documents/${data.documentId}`);
          return;
        } catch (e) {
          if (attempt === 1) throw e;
          await new Promise((r) => window.setTimeout(r, 1200));
        }
      }
    } catch {
      window.alert("无法打开在线编辑器：应用可能刚重启或网络中断，请刷新页面后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className={className} disabled={busy} onClick={() => void open()}>
      {busy ? "打开中…" : label}
    </button>
  );
}
