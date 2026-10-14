import { redirect } from "next/navigation";

// 令牌页已并入 /settings（AI 设置）。旧路由留着跳过去，
// 免得书签、外部文档里的链接、以及绑定飞书回跳拼出来的地址落到 404。
export default function TokensPage() {
  redirect("/settings");
}
