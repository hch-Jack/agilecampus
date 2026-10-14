"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { TZ_COOKIE } from "@/lib/time";
import { syncBrowserTimeZone } from "./settings/actions";

/**
 * 「跟随浏览器」的落地方式：服务端无法自己知道浏览器在哪个时区，只能由浏览器报上来。
 *
 * 只在用户确实选了「跟随浏览器」时才跑（其余偏好服务端直接读库）。
 * 首次请求必然先用默认的中国时间渲染出来 —— 那时 cookie 还没落地；
 * 值变了才发一次 action 并 refresh，所以正常浏览时这里全程安静。
 */
export function TzSync({ auto }: { auto: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!auto) return;

    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return; // 老浏览器不认这个 API：留在默认时区，比乱报一个值强
    }
    if (!tz) return;

    const current = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${TZ_COOKIE}=`))
      ?.slice(TZ_COOKIE.length + 1);
    // cookie 值可能被百分号编码，两种形式都认，免得每次都白跑一趟
    if (current === tz || current === encodeURIComponent(tz)) return;

    void syncBrowserTimeZone(tz).then(() => router.refresh());
  }, [auto, router]);

  return null;
}
