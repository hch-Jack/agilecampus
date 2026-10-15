"use client";

import { usePathname } from "next/navigation";
import { unbindFeishuAction } from "../settings/actions";
import { Modal } from "./modal";

// 「绑定飞书」小窗：绑定状态与解绑入口。绑定走飞书 OAuth 整页跳转（Route Handler），
// 完成后回 /settings?feishu=bound 展示结果横幅。
export function FeishuModal({
  boundName,
  boundAtLabel,
  onClose,
}: {
  boundName: string | null;
  boundAtLabel: string | null;
  onClose: () => void;
}) {
  const pathname = usePathname();
  return (
    <Modal title="绑定飞书" onClose={onClose}>
      <div className="space-y-3 p-5">
        <p className="text-sm text-ink-soft">
          绑定飞书后，任务被指派、完成，以及临期/逾期时，你会收到飞书私信提醒。
        </p>

        {boundName ? (
          <div className="flex items-center justify-between gap-4">
            <div className="text-sm text-ink">
              已绑定：<span className="font-medium">{boundName}</span>
              {boundAtLabel && <span className="ml-2 text-ink-faint">（{boundAtLabel}）</span>}
            </div>
            <form action={unbindFeishuAction}>
              <input type="hidden" name="from" value={pathname} />
              <button type="submit" className="ac-btn-ghost text-sm">
                解绑
              </button>
            </form>
          </div>
        ) : (
          <>
            {/* /api/auth/feishu/login 是 Route Handler 而非页面（规则误判）；OAuth 起点须整页跳转，
                走 next/link 的客户端路由会拿不到服务端 302。 */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/api/auth/feishu/login" className="ac-btn inline-block text-sm">
              绑定飞书
            </a>
          </>
        )}
      </div>
    </Modal>
  );
}
