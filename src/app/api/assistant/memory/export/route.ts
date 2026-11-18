import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { exportAssistantMemory } from "@/lib/agent/memory-transfer";

function filename(now: Date): string {
  // 只用于下载文件名，按 UTC 日期取即可（同一天内跨时区差异不影响理解）
  const day = now.toISOString().slice(0, 10);
  return `agilecampus-memory-${day}.json`;
}

// 记忆导出：个人上下文 + 个人会话消息 + 「记得多少上文」偏好，一个 JSON 快照。
// 只读、只导自己的 —— actorId 恒取 session。
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "请先登录" }, { status: 401 });

  const doc = await exportAssistantMemory(session.user.id);
  const body = JSON.stringify(doc, null, 2);
  return new Response(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename(new Date())}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    },
  });
}
