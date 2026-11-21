"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FilePreviewModal,
  type PreviewOperationOption,
  type PreviewVersionOption,
} from "@/components/file-preview";
import { deleteVersionAction } from "@/app/(app)/library/actions";
import { formatShortDateTime } from "@/lib/time";

type DetailResponse = {
  item: {
    id: string;
    filename: string;
    mimeType: string | null;
    size: number;
    currentVersion: number;
  };
  permissions: { canEdit: boolean; canManage: boolean; role: string | null };
  versions: {
    version: number;
    filename: string;
    mimeType: string | null;
    size: number;
    note: string;
    origin: string;
    creatorName: string | null;
    createdAt: string;
  }[];
  operations: {
    id: string;
    actorName: string;
    type: string;
    newValue: string | null;
    note: string | null;
    createdAt: string;
  }[];
  contentUrl: string;
};

export function LibraryPreviewDialog({
  itemId,
  timeZone,
  onClose,
}: {
  itemId: string;
  timeZone: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [detail, setDetail] = useState<DetailResponse | null>(null);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/library/items/${itemId}`);
    if (!res.ok) {
      setError("无法加载资源库文件");
      return;
    }
    const data = (await res.json()) as DetailResponse;
    setDetail(data);
    setActiveVersion((prev) =>
      prev && data.versions.some((v) => v.version === prev)
        ? prev
        : data.item.currentVersion,
    );
  }, [itemId]);

  useEffect(() => {
    // 延迟一拍，避免在 effect 内同步 setState（React Compiler 规则）
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function restore(version: number) {
    if (!confirm(`恢复 v${version} 为最新版本？会生成一个新版本，历史不会丢失。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/library/items/${itemId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        window.alert(data?.error ?? "恢复失败");
        return;
      }
      setActiveVersion(null);
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeVersion(version: number) {
    if (!confirm(`删除历史版本 v${version}？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      const res = await deleteVersionAction(itemId, version);
      if (!res.ok) {
        window.alert(res.error);
        return;
      }
      await load();
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
        <div className="ac-card max-w-sm p-5 text-center">
          <p className="text-sm text-high">{error}</p>
          <button type="button" className="ac-btn mt-3" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  if (!detail || activeVersion === null) {
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
        <div className="ac-card max-w-sm p-5 text-center text-sm text-ink-faint">
          正在加载文件…
          <button type="button" className="ac-btn mt-3 block w-full" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    );
  }

  const version = detail.versions.find((v) => v.version === activeVersion) ?? detail.versions[0];
  const isCurrent = activeVersion === detail.item.currentVersion;
  const versions: PreviewVersionOption[] = detail.versions.map((v) => ({
    version: v.version,
    filename: v.filename,
    mimeType: v.mimeType,
    size: v.size,
    note: v.note,
    origin: v.origin,
    creatorName: v.creatorName,
    createdAt: v.createdAt,
    createdAtLabel: formatShortDateTime(timeZone, new Date(v.createdAt)),
  }));
  const operations: PreviewOperationOption[] = detail.operations.map((o) => ({
    id: o.id,
    actorName: o.actorName,
    type: o.type,
    newValue: o.newValue,
    note: o.note,
    createdAt: o.createdAt,
    createdAtLabel: formatShortDateTime(timeZone, new Date(o.createdAt)),
  }));

  return (
    <FilePreviewModal
      file={{
        url: `${detail.contentUrl}?version=${activeVersion}`,
        filename: version?.filename ?? detail.item.filename,
        mimeType: version?.mimeType ?? detail.item.mimeType,
        size: version?.size ?? detail.item.size,
      }}
      onClose={onClose}
      edit={
        isCurrent && detail.permissions.canEdit
          ? { sourceType: "library_item", sourceId: itemId }
          : null
      }
      versionSidebar={{
        versions,
        activeVersion,
        currentVersion: detail.item.currentVersion,
        canRestore: detail.permissions.canEdit,
        busy,
        operations,
        onSelectVersion: setActiveVersion,
        onRestore: (v) => void restore(v),
        onDeleteVersion: (v) => void removeVersion(v),
      }}
    />
  );
}
