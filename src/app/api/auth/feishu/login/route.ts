import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { isHttpsRequest } from "@/lib/feishu";

const BASE = process.env.FEISHU_BASE_URL ?? "https://open.feishu.cn";

// 发起飞书 OAuth——登录与绑定共用。用途由 callback 按 session 有无分流。
export async function GET(req: Request) {
  const state = randomBytes(16).toString("hex");
  const store = await cookies();
  store.set("feishu_oauth_state", state, {
    httpOnly: true,
    sameSite: "lax",
    // 只有真的 https 才打 Secure。按 NODE_ENV 判会在「生产构建 + 局域网 http」这种
    // 很常见的部署上把 cookie 丢掉，回调读不到 state →「绑定校验失败」。
    secure: isHttpsRequest(req),
    maxAge: 600,
    path: "/",
  });

  const authorize = new URL(`${BASE}/open-apis/authen/v1/authorize`);
  authorize.searchParams.set("app_id", process.env.FEISHU_APP_ID ?? "");
  authorize.searchParams.set("redirect_uri", process.env.FEISHU_REDIRECT_URI ?? "");
  authorize.searchParams.set("state", state);
  return NextResponse.redirect(authorize);
}
