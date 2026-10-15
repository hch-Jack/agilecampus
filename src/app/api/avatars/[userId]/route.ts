import { z } from "zod";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { users } from "@/db/schema";

type Ctx = { params: Promise<{ userId: string }> };

// 用户头像：私信列表/聊天窗口里显示对方头像。内容按版本号寻址
// （URL 带 ?v=avatarUpdatedAt，见 lib/user.ts 的 userAvatarUrl），
// 换头像即换地址，所以这里可以放心长缓存；没传过头像就 404，客户端回落成名字首字。
export async function GET(_req: Request, ctx: Ctx) {
  const session = await auth();
  if (!session?.user) return Response.json({ error: "未登录" }, { status: 401 });

  const { userId } = await ctx.params;
  if (!z.uuid().safeParse(userId).success) return new Response(null, { status: 404 });

  const [row] = await db
    .select({ data: users.avatarData, mime: users.avatarMime })
    .from(users)
    .where(eq(users.id, userId));
  if (!row?.data) return new Response(null, { status: 404 });

  // Buffer 不入 BodyInit 类型（TS 5.7 泛型 Uint8Array 亦不兼容 BufferSource），拷一份纯 ArrayBuffer 视图
  const body = Uint8Array.from(row.data);
  return new Response(body, {
    headers: {
      "Content-Type": row.mime ?? "application/octet-stream",
      "Content-Length": String(row.data.length),
      "Cache-Control": "public, max-age=31536000, immutable",
      // 只放行三种白名单 MIME 的字节（入库前按魔数验过），nosniff 双保险
      "X-Content-Type-Options": "nosniff",
    },
  });
}
