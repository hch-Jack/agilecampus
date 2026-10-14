import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveUserTimeZone } from "@/lib/time-pref";
import { MessagesClient } from "./messages-client";

export default async function MessagesPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // 数据全走 client 轮询的 server action（会话列表 + 会话内消息），页面只做登录门禁；
  // 时区要在服务端定下来传给客户端 —— 客户端只知道浏览器时区，那不是用户的偏好
  const timeZone = await resolveUserTimeZone(session.user.id);
  return <MessagesClient timeZone={timeZone} />;
}
