import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { MessagesClient } from "./messages-client";

export default async function MessagesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // 数据全走 client 轮询的 server action（会话列表 + 会话内消息），页面只做登录门禁
  return <MessagesClient />;
}
